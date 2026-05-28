import { Redis } from '@upstash/redis';
import { createHash } from 'node:crypto';
import type { Job, ScrapedJd, StoredPdf, TailoredResume, TrackedUrl } from './types';

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
const jobKey = (id: string) => `job:${id}`;
const trackerKey = (id: string) => `tracker:${id}`;
const jdKey = (id: string) => `jd:${id}`;
const tailoredKey = (id: string) => `tailored:${id}`;
const pdfKey = (id: string) => `pdf:${id}`;

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
  patch: Partial<Pick<TrackedUrl, 'status' | 'note' | 'company' | 'role'>>
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
