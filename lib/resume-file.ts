import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The resume PDF attached to every outreach email (user's instruction 2026-08-09).
 *
 * ⚠️ THE FILENAME IS WHAT THE FOUNDER SEES in their mail client, so it is deliberately a
 * clean `Harshit_Verma_Resume.pdf`.
 *
 * Read from disk at send time rather than bundled as base64: the file is ~152KB and would
 * bloat every serverless function that transitively imports the mailer. `process.cwd()` is
 * the project root in a Vercel function, and the read is cached after the first send.
 */

const RESUME_PATH = ['profile', 'Harshit_Verma_Resume.pdf'];
export const RESUME_FILENAME = 'Harshit_Verma_Resume.pdf';

let cached: Buffer | null = null;

/**
 * Returns null rather than throwing when the file is missing. A missing attachment must not
 * take down the send: an outreach email that arrives without the resume is a great deal
 * better than one that never arrives, and the caller surfaces the omission.
 */
export async function readResumePdf(): Promise<Buffer | null> {
  if (cached) return cached;
  try {
    const buf = await readFile(path.join(process.cwd(), ...RESUME_PATH));
    // Guard against a truncated or wrong-typed file being mailed to a founder.
    if (buf.length < 1000 || buf.subarray(0, 5).toString() !== '%PDF-') return null;
    cached = buf;
    return cached;
  } catch {
    return null;
  }
}

/**
 * How the resume reaches the recipient: attached, linked, or both.
 *
 * ⚠️ `attach` IS THE DEFAULT AND THAT IS A DELIBERATE RECOMMENDATION, not inertia. Asked
 * whether a Google Drive link would help with spam placement (2026-08-18), the honest answer is
 * that it is as likely to hurt:
 *
 *  - A file-sharing link from an unknown sender is a textbook phishing shape. Microsoft 365
 *    and Outlook, which plenty of Indian startups run on, score `drive.google.com` links from
 *    strangers harder than they score a small PDF.
 *  - The failure mode is SILENT AND WORSE. If Drive sharing is not "anyone with the link", the
 *    recruiter hits a request-access wall and it reads exactly like being ignored. An
 *    attachment either arrives or bounces, and a bounce is something this project detects.
 *  - Recruiters forward the mail into an ATS or file the attachment. No file often means no
 *    resume in their system.
 *  - And a ~150KB PDF is a modest signal next to the real one: sending volume. The 5-to-20
 *    daily jump matters far more than how the resume travels.
 *
 * `both` is the hedge worth trying: the file for the ATS, the link for a phone reader and as a
 * fallback if a filter strips the attachment. `link` alone drops the attachment entirely.
 *
 *   RESUME_DELIVERY  attach (default) | link | both
 *   RESUME_LINK_URL  the share URL. Without it, `link` and `both` fall back to attaching,
 *                    because sending no resume at all is the one outcome worse than either.
 */
export type ResumeDelivery = 'attach' | 'link' | 'both';

export function resumeLinkUrl(): string {
  return process.env.RESUME_LINK_URL?.trim() ?? '';
}

export function resumeDelivery(): ResumeDelivery {
  const raw = process.env.RESUME_DELIVERY?.trim().toLowerCase();
  if ((raw === 'link' || raw === 'both') && resumeLinkUrl()) return raw;
  return 'attach';
}
