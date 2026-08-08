import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The resume PDF attached to every outreach email (user's instruction 2026-08-09).
 *
 * ⚠️ THE FILENAME IS WHAT THE FOUNDER SEES in their mail client, so it is deliberately a
 * clean `Shivansh_Chaudhary_Resume.pdf` rather than the source file's name, which arrived
 * as `Shivansh_Ch_Resume.pdf.pdf`.
 *
 * Read from disk at send time rather than bundled as base64: the file is ~152KB and would
 * bloat every serverless function that transitively imports the mailer. `process.cwd()` is
 * the project root in a Vercel function, and the read is cached after the first send.
 */

const RESUME_PATH = ['profile', 'Shivansh_Chaudhary_Resume.pdf'];
export const RESUME_FILENAME = 'Shivansh_Chaudhary_Resume.pdf';

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
