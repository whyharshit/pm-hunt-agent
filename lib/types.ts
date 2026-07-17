export type Job = {
  id: string;
  source: 'remoteok' | 'hn' | 'wwr' | 'wellfound' | 'yc';
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl?: string;
  postedAt: Date;
  tags: string[];
  description?: string;
  salary?: string;
};

import type { Tier } from './classify';

export type TrackedUrl = {
  id: string;
  url: string;
  tier: Tier;
  source: 'telegram';
  addedAt: string;
  status: 'new' | 'drafted' | 'submitted' | 'rejected' | 'skipped';
  note?: string;
  company?: string;
  role?: string;
  /** Last tailor-pipeline error, surfaced on the dashboard; cleared on success. */
  tailorError?: string | null;
};

export type JdSource = 'lever' | 'greenhouse' | 'ashby' | 'workable' | 'jsonld' | 'generic';

export type ScrapedJd = {
  text: string;
  title?: string;
  company?: string;
  role?: string;
  source: JdSource;
  scrapedAt: string;
  url: string;
};

export type TailoredExperience = {
  role: string;
  company: string;
  bullets: string[];
};

export type TailoredResume = {
  trackerId: string;
  summary: string;
  experience: TailoredExperience[];
  generatedAt: string;
  model: string;
  jdScrapedAt: string;
};

export type StoredPdf = {
  base64: string;
  size: number;
  generatedAt: string;
  tailoredAt: string | null;
};

export type Blurb = {
  trackerId: string;
  text: string;
  reference: string;
  generatedAt: string;
  model: string;
  jdScrapedAt: string;
};

export type FundingItem = {
  id: string;
  company: string;
  amount?: string;
  round?: string;
  summary: string;
  url: string;
  source: 'techcrunch';
  postedAt: string;
  status: 'new' | 'contacted' | 'skipped';
};

export type FundingOutreach = {
  id: string;
  text: string;
  angle: string;
  generatedAt: string;
  model: string;
};

export type ContactPerson = {
  name: string;
  title?: string;
};

export type ContactEmail = {
  address: string;
  /** Page the address was literally found on. Addresses are never inferred or guessed. */
  foundOn: string;
};

export type FundingContact = {
  id: string;
  founders: ContactPerson[];
  website?: string;
  emails: ContactEmail[];
  socials: string[];
  foundAt: string;
  model: string;
  /** Why a lookup came back thin (no site linked, site unreachable, no public email). */
  note?: string;
};

export type AgentRun = {
  agentId: string;
  state: 'idle' | 'running' | 'ok' | 'error';
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  stats?: Record<string, number>;
  error?: string | null;
};
