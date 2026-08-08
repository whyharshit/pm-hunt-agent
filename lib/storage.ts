import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';
import type {
  AgentRun,
  Blurb,
  FundingContact,
  FundingItem,
  FundingOutreach,
  GformPrefill,
  Job,
  ScrapedJd,
  StoredPdf,
  TailoredResume,
  TrackedUrl,
  WhatsappLead,
} from './types';

let _redis: Redis | null = null;
function redis(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Upstash KV env vars missing (KV_REST_API_URL, KV_REST_API_TOKEN)');
  _redis = new Redis({ url, token });
  return _redis;
}

const SEEN_KEY = 'seen:ids';
const JOBS_INDEX = 'jobs:index';
const TRACKER_INDEX = 'tracker:index';
const FUNDING_INDEX = 'funding:index';
const FUNDING_SEEN = 'funding:seen';
const WA_LEAD_INDEX = 'walead:index';
/** Group chatter is high-volume, so dedupe keys expire instead of growing a set forever. */
const WA_SEEN_TTL_SECONDS = 60 * 60 * 24 * 45;
const jobKey = (id: string) => `job:${id}`;
const trackerKey = (id: string) => `tracker:${id}`;
const fundingKey = (id: string) => `funding:${id}`;
const fundingOutreachKey = (id: string) => `funding-outreach:${id}`;
const fundingContactKey = (id: string) => `funding-contact:${id}`;
const gformKey = (id: string) => `gform:${id}`;
const waSeenKey = (id: string) => `wa:seen:${id}`;
const waLeadKey = (id: string) => `walead:${id}`;
const agentKey = (id: string) => `agent:${id}`;
const jdKey = (id: string) => `jd:${id}`;
const tailoredKey = (id: string) => `tailored:${id}`;
const pdfKey = (id: string) => `pdf:${id}`;
const blurbKey = (id: string) => `blurb:${id}`;

export function urlId(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

export async function getSeenIds(): Promise<Set<string>> {
  const ids = await redis().smembers(SEEN_KEY);
  return new Set(ids as string[]);
}

export async function markSeen(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await redis().sadd(SEEN_KEY, ids[0], ...ids.slice(1));
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  if (jobs.length === 0) return;
  const pipe = redis().pipeline();
  for (const j of jobs) {
    const score = +new Date(j.postedAt);
    pipe.set(jobKey(j.id), JSON.stringify(j));
    pipe.zadd(JOBS_INDEX, { score, member: j.id });
  }
  await pipe.exec();
}

export async function getRecentJobs(limit = 50): Promise<Job[]> {
  const ids = (await redis().zrange(JOBS_INDEX, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(jobKey(id));
  const raws = (await pipe.exec()) as (string | Job | null)[];
  const jobs: Job[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    const j = typeof raw === 'string' ? (JSON.parse(raw) as Job) : raw;
    jobs.push(j);
  }
  return jobs;
}

export async function getTracked(id: string): Promise<TrackedUrl | null> {
  const raw = await redis().get(trackerKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as TrackedUrl) : (raw as TrackedUrl);
}

export async function saveTracked(t: TrackedUrl): Promise<void> {
  const score = +new Date(t.addedAt);
  const pipe = redis().pipeline();
  pipe.set(trackerKey(t.id), JSON.stringify(t));
  pipe.zadd(TRACKER_INDEX, { score, member: t.id });
  await pipe.exec();
}

export async function updateTracked(
  id: string,
  patch: Partial<Pick<TrackedUrl, 'status' | 'note' | 'company' | 'role' | 'tailorError'>>
): Promise<TrackedUrl | null> {
  const existing = await getTracked(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  await redis().set(trackerKey(id), JSON.stringify(next));
  return next;
}

export async function getJd(id: string): Promise<ScrapedJd | null> {
  const raw = await redis().get(jdKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as ScrapedJd) : (raw as ScrapedJd);
}

export async function saveJd(id: string, jd: ScrapedJd): Promise<void> {
  await redis().set(jdKey(id), JSON.stringify(jd));
}

export async function getTailored(id: string): Promise<TailoredResume | null> {
  const raw = await redis().get(tailoredKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as TailoredResume) : (raw as TailoredResume);
}

export async function saveTailored(id: string, t: TailoredResume): Promise<void> {
  await redis().set(tailoredKey(id), JSON.stringify(t));
}

export async function getPdf(id: string): Promise<StoredPdf | null> {
  const raw = await redis().get(pdfKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as StoredPdf) : (raw as StoredPdf);
}

export async function savePdf(id: string, pdf: StoredPdf): Promise<void> {
  await redis().set(pdfKey(id), JSON.stringify(pdf));
}

export async function getBlurb(id: string): Promise<Blurb | null> {
  const raw = await redis().get(blurbKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as Blurb) : (raw as Blurb);
}

export async function saveBlurb(id: string, b: Blurb): Promise<void> {
  await redis().set(blurbKey(id), JSON.stringify(b));
}

export async function getAgentRun(id: string): Promise<AgentRun | null> {
  const raw = await redis().get(agentKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as AgentRun) : (raw as AgentRun);
}

/** Batch-fetch run-state for the agent cards in one pipeline. */
export async function getAgentRuns(ids: string[]): Promise<Map<string, AgentRun>> {
  const out = new Map<string, AgentRun>();
  if (ids.length === 0) return out;
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(agentKey(id));
  const raws = (await pipe.exec()) as (string | AgentRun | null)[];
  ids.forEach((id, i) => {
    const raw = raws[i];
    if (!raw) return;
    out.set(id, typeof raw === 'string' ? (JSON.parse(raw) as AgentRun) : raw);
  });
  return out;
}

export async function setAgentRunning(id: string): Promise<void> {
  const run: AgentRun = { agentId: id, state: 'running', startedAt: new Date().toISOString() };
  await redis().set(agentKey(id), JSON.stringify(run));
}

/** Merge a run result onto the agent's current record and stamp finishedAt. */
export async function recordAgentRun(
  id: string,
  patch: Partial<Omit<AgentRun, 'agentId'>>
): Promise<void> {
  const existing = await getAgentRun(id);
  const next: AgentRun = {
    ...(existing ?? { agentId: id, state: 'idle' }),
    ...patch,
    agentId: id,
    finishedAt: patch.finishedAt ?? new Date().toISOString(),
  };
  await redis().set(agentKey(id), JSON.stringify(next));
}

export async function getFundingSeen(): Promise<Set<string>> {
  const ids = await redis().smembers(FUNDING_SEEN);
  return new Set(ids as string[]);
}

export async function markFundingSeen(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await redis().sadd(FUNDING_SEEN, ids[0], ...ids.slice(1));
}

export async function saveFundingItems(items: FundingItem[]): Promise<void> {
  if (items.length === 0) return;
  const pipe = redis().pipeline();
  for (const it of items) {
    pipe.set(fundingKey(it.id), JSON.stringify(it));
    pipe.zadd(FUNDING_INDEX, { score: +new Date(it.postedAt), member: it.id });
  }
  await pipe.exec();
}

export async function getRecentFunding(limit = 50): Promise<FundingItem[]> {
  const ids = (await redis().zrange(FUNDING_INDEX, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(fundingKey(id));
  const raws = (await pipe.exec()) as (string | FundingItem | null)[];
  const out: FundingItem[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    out.push(typeof raw === 'string' ? (JSON.parse(raw) as FundingItem) : raw);
  }
  return out;
}

export async function getFundingItem(id: string): Promise<FundingItem | null> {
  const raw = await redis().get(fundingKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as FundingItem) : (raw as FundingItem);
}

export async function updateFundingStatus(id: string, status: FundingItem['status']): Promise<void> {
  const existing = await getFundingItem(id);
  if (!existing) return;
  await redis().set(fundingKey(id), JSON.stringify({ ...existing, status }));
}

export async function getFundingOutreach(id: string): Promise<FundingOutreach | null> {
  const raw = await redis().get(fundingOutreachKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as FundingOutreach) : (raw as FundingOutreach);
}

export async function saveFundingOutreach(id: string, o: FundingOutreach): Promise<void> {
  await redis().set(fundingOutreachKey(id), JSON.stringify(o));
}

/** Batch-fetch generated outreach drafts for the funding rows in one pipeline. */
export async function getFundingOutreaches(ids: string[]): Promise<Map<string, FundingOutreach>> {
  const out = new Map<string, FundingOutreach>();
  if (ids.length === 0) return out;
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(fundingOutreachKey(id));
  const raws = (await pipe.exec()) as (string | FundingOutreach | null)[];
  ids.forEach((id, i) => {
    const raw = raws[i];
    if (!raw) return;
    out.set(id, typeof raw === 'string' ? (JSON.parse(raw) as FundingOutreach) : raw);
  });
  return out;
}

export async function getFundingContact(id: string): Promise<FundingContact | null> {
  const raw = await redis().get(fundingContactKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as FundingContact) : (raw as FundingContact);
}

export async function saveFundingContact(id: string, c: FundingContact): Promise<void> {
  await redis().set(fundingContactKey(id), JSON.stringify(c));
}

/** Batch-fetch resolved founder contacts for the funding rows in one pipeline. */
export async function getFundingContacts(ids: string[]): Promise<Map<string, FundingContact>> {
  const out = new Map<string, FundingContact>();
  if (ids.length === 0) return out;
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(fundingContactKey(id));
  const raws = (await pipe.exec()) as (string | FundingContact | null)[];
  ids.forEach((id, i) => {
    const raw = raws[i];
    if (!raw) return;
    out.set(id, typeof raw === 'string' ? (JSON.parse(raw) as FundingContact) : raw);
  });
  return out;
}

export async function getGformPrefill(id: string): Promise<GformPrefill | null> {
  const raw = await redis().get(gformKey(id));
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as GformPrefill) : (raw as GformPrefill);
}

export async function saveGformPrefill(id: string, p: GformPrefill): Promise<void> {
  await redis().set(gformKey(id), JSON.stringify(p));
}

/** Batch-fetch generated form pre-fills for the green tracked rows in one pipeline. */
export async function getGformPrefills(ids: string[]): Promise<Map<string, GformPrefill>> {
  const out = new Map<string, GformPrefill>();
  if (ids.length === 0) return out;
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(gformKey(id));
  const raws = (await pipe.exec()) as (string | GformPrefill | null)[];
  ids.forEach((id, i) => {
    const raw = raws[i];
    if (!raw) return;
    out.set(id, typeof raw === 'string' ? (JSON.parse(raw) as GformPrefill) : raw);
  });
  return out;
}

/**
 * Atomically claim WhatsApp message ids, returning only the ones not seen before.
 * `SET NX` is the claim — two bridge instances (or a retried POST) can't both process
 * the same message. Keys carry a TTL rather than living in an unbounded set, because
 * unlike the daily job feeds this ingests continuous group traffic.
 */
export async function claimWhatsappMessages(ids: string[]): Promise<Set<string>> {
  const fresh = new Set<string>();
  if (ids.length === 0) return fresh;
  const unique = Array.from(new Set(ids));
  const pipe = redis().pipeline();
  for (const id of unique) pipe.set(waSeenKey(id), 1, { nx: true, ex: WA_SEEN_TTL_SECONDS });
  const res = (await pipe.exec()) as (string | null)[];
  unique.forEach((id, i) => {
    if (res[i] !== null) fresh.add(id);
  });
  return fresh;
}

export async function saveWhatsappLeads(leads: WhatsappLead[]): Promise<void> {
  if (leads.length === 0) return;
  const pipe = redis().pipeline();
  for (const l of leads) {
    pipe.set(waLeadKey(l.id), JSON.stringify(l));
    pipe.zadd(WA_LEAD_INDEX, { score: +new Date(l.postedAt), member: l.id });
  }
  await pipe.exec();
}

export async function getRecentWhatsappLeads(limit = 50): Promise<WhatsappLead[]> {
  const ids = (await redis().zrange(WA_LEAD_INDEX, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(waLeadKey(id));
  const raws = (await pipe.exec()) as (string | WhatsappLead | null)[];
  const out: WhatsappLead[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    out.push(typeof raw === 'string' ? (JSON.parse(raw) as WhatsappLead) : raw);
  }
  return out;
}

export async function updateWhatsappLeadStatus(
  id: string,
  status: WhatsappLead['status']
): Promise<void> {
  const raw = await redis().get(waLeadKey(id));
  if (!raw) return;
  const existing = typeof raw === 'string' ? (JSON.parse(raw) as WhatsappLead) : (raw as WhatsappLead);
  await redis().set(waLeadKey(id), JSON.stringify({ ...existing, status }));
}

/** Remove a tracked row AND its per-tracker artifacts, so no orphaned PDFs/blurbs linger. */
export async function deleteTracked(id: string): Promise<void> {
  const pipe = redis().pipeline();
  pipe.del(trackerKey(id));
  pipe.zrem(TRACKER_INDEX, id);
  pipe.del(jdKey(id));
  pipe.del(tailoredKey(id));
  pipe.del(pdfKey(id));
  pipe.del(blurbKey(id));
  pipe.del(gformKey(id));
  await pipe.exec();
}

/**
 * Remove a funding row and everything derived from it. The id stays in `funding:seen` on
 * purpose — the same article is still in the feeds, and without that marker the next scan
 * would resurrect a row the user deliberately deleted.
 */
export async function deleteFundingItem(id: string): Promise<void> {
  const pipe = redis().pipeline();
  pipe.del(fundingKey(id));
  pipe.zrem(FUNDING_INDEX, id);
  pipe.del(fundingOutreachKey(id));
  pipe.del(fundingContactKey(id));
  await pipe.exec();
}

export async function deleteWhatsappLead(id: string): Promise<void> {
  const pipe = redis().pipeline();
  pipe.del(waLeadKey(id));
  pipe.zrem(WA_LEAD_INDEX, id);
  await pipe.exec();
}

export async function deleteJob(id: string): Promise<void> {
  const pipe = redis().pipeline();
  pipe.del(jobKey(id));
  pipe.zrem(JOBS_INDEX, id);
  // Deliberately NOT removed from seen:ids — a purged test job must not come back on the
  // next discovery run if a source still serves it.
  await pipe.exec();
}

export type TrackedArtifacts = { hasPdf: boolean; blurb: Blurb | null };

/** Batch-fetch dashboard artifacts (PDF presence + blurb text) for tracked rows. */
export async function getTrackedArtifacts(
  ids: string[]
): Promise<Map<string, TrackedArtifacts>> {
  const out = new Map<string, TrackedArtifacts>();
  if (ids.length === 0) return out;
  const pipe = redis().pipeline();
  for (const id of ids) {
    pipe.exists(pdfKey(id));
    pipe.get(blurbKey(id));
  }
  const res = (await pipe.exec()) as unknown[];
  ids.forEach((id, i) => {
    const exists = res[i * 2] as number;
    const raw = res[i * 2 + 1] as string | Blurb | null;
    const blurb = raw ? (typeof raw === 'string' ? (JSON.parse(raw) as Blurb) : raw) : null;
    out.set(id, { hasPdf: exists === 1, blurb });
  });
  return out;
}

export async function getRecentTracked(limit = 50): Promise<TrackedUrl[]> {
  const ids = (await redis().zrange(TRACKER_INDEX, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.get(trackerKey(id));
  const raws = (await pipe.exec()) as (string | TrackedUrl | null)[];
  const out: TrackedUrl[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    out.push(typeof raw === 'string' ? (JSON.parse(raw) as TrackedUrl) : raw);
  }
  return out;
}
