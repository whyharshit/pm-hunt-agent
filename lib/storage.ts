import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Job } from './types';

// Dev: file-based dedupe at ./data/seen.json.
// Prod: we'll swap to Google Sheets or Upstash KV later.

const DATA_DIR = path.join(process.cwd(), 'data');
const SEEN_FILE = path.join(DATA_DIR, 'seen.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

type SeenIndex = { ids: string[] };
type JobsIndex = { jobs: Job[] };

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function getSeenIds(): Promise<Set<string>> {
  const idx = await readJson<SeenIndex>(SEEN_FILE, { ids: [] });
  return new Set(idx.ids);
}

export async function markSeen(ids: string[]): Promise<void> {
  await ensureDir();
  const idx = await readJson<SeenIndex>(SEEN_FILE, { ids: [] });
  const merged = Array.from(new Set([...idx.ids, ...ids])).slice(-5000);
  await fs.writeFile(SEEN_FILE, JSON.stringify({ ids: merged }, null, 2));
}

export async function saveJobs(jobs: Job[]): Promise<void> {
  await ensureDir();
  const idx = await readJson<JobsIndex>(JOBS_FILE, { jobs: [] });
  const byId = new Map<string, Job>(idx.jobs.map((j) => [j.id, j]));
  for (const j of jobs) byId.set(j.id, j);
  const all = Array.from(byId.values())
    .sort((a, b) => +new Date(b.postedAt) - +new Date(a.postedAt))
    .slice(0, 5000);
  await fs.writeFile(JOBS_FILE, JSON.stringify({ jobs: all }, null, 2));
}

export async function getRecentJobs(limit = 50): Promise<Job[]> {
  const idx = await readJson<JobsIndex>(JOBS_FILE, { jobs: [] });
  return idx.jobs.slice(0, limit);
}
