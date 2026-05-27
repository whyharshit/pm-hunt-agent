import { Redis } from '@upstash/redis';
import type { Job } from './types';

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
const jobKey = (id: string) => `job:${id}`;

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
