import { GoogleGenAI } from '@google/genai';
import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';

/**
 * One Gemini entry point for every agent, so the free-tier quota can be pooled across
 * several keys.
 *
 * WHY THIS EXISTS: the Gemini free tier allows **20 requests per day per project** for
 * `gemini-2.5-flash` (quota id `GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
 * measured 2026-08-08 — the per-minute limit of 5 is the one that shows up first, but the
 * daily 20 is what actually stops the work). Every agent shares it: funding extraction,
 * contact extraction, outreach drafting, resume tailoring, blurbs, form pre-fill. Founder
 * outreach alone costs 2 calls per row, so a single key caps the whole system at ~8-10
 * rows a day. The user chose to supply several free keys rather than enable billing.
 *
 * Keys come from `GEMINI_API_KEYS` (comma-separated, one project each — keys from the SAME
 * project share one quota and buy nothing). `GEMINI_API_KEY` stays supported as a single
 * key so nothing breaks if only the old var is set; both are merged and de-duplicated.
 *
 * On a 429 the call moves to the next key and retries. A rejected request does not consume
 * quota, so trying a spent key costs latency, not budget — which is why this needs no
 * exhaustion bookkeeping and no Redis state to go stale. The starting key is chosen at
 * random so concurrent invocations spread across the pool instead of all hammering the
 * first key and failing over in lockstep.
 */

/**
 * The model every agent asks for.
 *
 * ⚠️ NOT `gemini-2.5-flash` any more. Google has retired it for NEW projects: a freshly
 * created key 404s with "This model models/gemini-2.5-flash is no longer available to new
 * users" — **even though `models.list` still returns it for that same key**. Measured
 * 2026-08-08 while adding five new keys: the listing said yes, generateContent said no.
 * Listing a model is not proof you can call it, and older projects keep working, which is
 * how a mixed-age key pool ends up half broken with no obvious cause.
 */
export const FLASH_MODEL = 'gemini-3.6-flash';

/**
 * Tried in order when a key rejects the requested model, so an old key that only knows 2.5
 * and a new key that only knows 3.x can sit in the same pool. Degrades per-key, not
 * per-system.
 */
const MODEL_FALLBACKS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];

/** A quota rejection — worth trying another key. Anything else is a real error. */
function isQuotaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|\b429\b|quota/i.test(msg);
}

/** This KEY cannot serve this MODEL — another model may work; another key will not. */
function isModelUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no longer available|not found|is not supported|NOT_FOUND|\b404\b/i.test(msg);
}

export function geminiKeys(): string[] {
  const raw = [process.env.GEMINI_API_KEYS ?? '', process.env.GEMINI_API_KEY ?? ''].join(',');
  const keys = raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

/** How many keys are configured. Surfaced on the dashboard so a missing key is visible. */
export function geminiKeyCount(): number {
  return geminiKeys().length;
}

export class GeminiQuotaError extends Error {
  constructor(keyCount: number) {
    super(
      `all ${keyCount} Gemini key${keyCount === 1 ? '' : 's'} are out of daily quota ` +
        `(free tier = 20 requests/day/project for gemini-2.5-flash) — add another key to ` +
        `GEMINI_API_KEYS or wait for the quota to reset`
    );
    this.name = 'GeminiQuotaError';
  }
}

/**
 * `ai.models.generateContent`, but across the key pool. Drop-in for every call site:
 * identical parameters, identical return value.
 */
export async function generateContent(
  params: GenerateContentParameters
): Promise<GenerateContentResponse> {
  const keys = geminiKeys();
  if (keys.length === 0) throw new Error('no Gemini key set — set GEMINI_API_KEYS');

  const requested = typeof params.model === 'string' ? params.model : FLASH_MODEL;
  const models = [requested, ...MODEL_FALLBACKS.filter((m) => m !== requested)];

  const start = Math.floor(Math.random() * keys.length);
  let quotaFailures = 0;
  let lastError: unknown;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length];
    const ai = new GoogleGenAI({ apiKey: key });
    let keyOutOfQuota = false;

    for (const model of models) {
      try {
        return await ai.models.generateContent({ ...params, model });
      } catch (e) {
        lastError = e;
        if (isQuotaError(e)) {
          // Quota is per project, not per model — no other model on this key will help.
          keyOutOfQuota = true;
          break;
        }
        if (isModelUnavailable(e)) continue; // this key is on an older/newer model set
        // Anything else (bad prompt, schema mismatch, network) fails identically
        // everywhere, so fail fast instead of burning the pool on it.
        throw e;
      }
    }

    if (keyOutOfQuota) quotaFailures++;
  }

  if (quotaFailures === keys.length) throw new GeminiQuotaError(keys.length);
  throw lastError;
}
