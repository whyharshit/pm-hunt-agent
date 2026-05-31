import {
  getJd,
  getTracked,
  saveBlurb,
  saveJd,
  savePdf,
  saveTailored,
  updateTracked,
} from './storage';
import { scrapeJd, ScrapeError } from './scrape';
import { tailorResume } from './tailor';
import { renderResumePdf } from './pdf/render';
import { writeBlurb } from './blurb';
import type { Blurb, ScrapedJd, StoredPdf, TailoredResume } from './types';

export type PipelineStage = 'lookup' | 'scrape' | 'tailor' | 'render' | 'blurb';

export type PipelineResult =
  | {
      ok: true;
      tailored: TailoredResume;
      pdf: StoredPdf;
      blurb: Blurb;
    }
  | {
      ok: false;
      stage: PipelineStage;
      error: string;
    };

/**
 * Runs the full tailor chain for a tracked URL: scrape JD → tailor bullets →
 * render PDF → write cold blurb. Calls the lib functions directly (no HTTP,
 * no bearer) so it can be driven from a dashboard server action. Always
 * regenerates — the dashboard "Tailor" button is an explicit refresh.
 */
export async function runTailorPipeline(id: string): Promise<PipelineResult> {
  const tracked = await getTracked(id);
  if (!tracked) return { ok: false, stage: 'lookup', error: 'tracker not found' };
  if (tracked.tier === 'green') {
    return { ok: false, stage: 'lookup', error: 'green tier — no JD to tailor against' };
  }

  let jd: ScrapedJd;
  try {
    const existing = await getJd(id);
    if (existing) {
      jd = existing;
    } else {
      jd = await scrapeJd(tracked.url);
      await saveJd(id, jd);
      const patch: Parameters<typeof updateTracked>[1] = {};
      if (!tracked.company && jd.company) patch.company = jd.company;
      if (!tracked.role && jd.role) patch.role = jd.role;
      if (Object.keys(patch).length > 0) await updateTracked(id, patch);
    }
  } catch (e) {
    const err = e as ScrapeError;
    return { ok: false, stage: 'scrape', error: err.message };
  }

  let tailored: TailoredResume;
  try {
    tailored = await tailorResume(id, jd);
    await saveTailored(id, tailored);
  } catch (e) {
    return { ok: false, stage: 'tailor', error: (e as Error).message };
  }

  let pdf: StoredPdf;
  try {
    const buf = await renderResumePdf({
      summary: tailored.summary,
      experience: tailored.experience,
    });
    pdf = {
      base64: buf.toString('base64'),
      size: buf.length,
      generatedAt: new Date().toISOString(),
      tailoredAt: tailored.generatedAt,
    };
    await savePdf(id, pdf);
  } catch (e) {
    return { ok: false, stage: 'render', error: (e as Error).message };
  }

  let blurb: Blurb;
  try {
    blurb = await writeBlurb(id, jd, tailored);
    await saveBlurb(id, blurb);
  } catch (e) {
    return { ok: false, stage: 'blurb', error: (e as Error).message };
  }

  return { ok: true, tailored, pdf, blurb };
}
