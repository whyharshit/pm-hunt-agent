import type { Job } from '../types';

type RemoteOkJob = {
  id: number | string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  location?: string;
  salary_min?: number;
  salary_max?: number;
  apply_url?: string;
  url?: string;
  description?: string;
};

export async function fetchRemoteOk(): Promise<Job[]> {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'pm-hunt-agent/1.0 (contact: hello@lovingroom.co)' },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`RemoteOK fetch failed: ${res.status}`);

  const raw = (await res.json()) as unknown[];
  const items = raw.filter((x): x is RemoteOkJob => {
    return typeof x === 'object' && x !== null && 'position' in x;
  });

  return items.map((j) => {
    const salary =
      j.salary_min && j.salary_max
        ? `$${j.salary_min.toLocaleString()}–$${j.salary_max.toLocaleString()}`
        : undefined;
    return {
      id: `remoteok:${j.id}`,
      source: 'remoteok',
      title: j.position ?? 'Unknown role',
      company: j.company ?? 'Unknown',
      location: j.location || 'Remote',
      url: j.url ?? `https://remoteok.com/remote-jobs/${j.slug ?? j.id}`,
      applyUrl: j.apply_url,
      postedAt: j.epoch ? new Date(j.epoch * 1000) : new Date(j.date ?? Date.now()),
      tags: j.tags ?? [],
      description: j.description,
      salary,
    };
  });
}
