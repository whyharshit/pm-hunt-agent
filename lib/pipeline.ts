import {
  getJd,
  getTracked,
  recordAgentRun,
  saveBlurb,
  saveJd,
  savePdf,
  saveTailored,
  setAgentRunning,
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

  await setAgentRunning('tailorer');
  const fail = async (stage: PipelineStage, error: string): Promise<PipelineResult> => {
    await recordAgentRun('tailorer', { state: 'error', summary: `${stage}: ${error}`, error });
    return { ok: false, stage, error };
  };

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
    return fail('scrape', (e as ScrapeError).message);
  }

  let tailored: TailoredResume;
  try {
    tailored = await tailorResume(id, jd);
    await saveTailored(id, tailored);
  } catch (e) {
    return fail('tailor', (e as Error).message);
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
    return fail('render', (e as Error).message);
  }

  let blurb: Blurb;
  try {
    blurb = await writeBlurb(id, jd, tailored);
    await saveBlurb(id, blurb);
  } catch (e) {
    return fail('blurb', (e as Error).message);
  }

  const label = tracked.company || tracked.role || new URL(tracked.url).hostname.replace(/^www\./, '');
  await recordAgentRun('tailorer', {
    state: 'ok',
    summary: `tailored ${label}`,
    error: null,
  });
  return { ok: true, tailored, pdf, blurb };
}
