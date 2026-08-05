export type Job = {
  id: string;
  source:
    | 'remoteok'
    | 'hn'
    | 'wwr'
    | 'wellfound'
    | 'yc'
    | 'internshala'
    | 'linkedin'
    | 'unstop'
    | 'apify';
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
  source: 'telegram' | 'manual' | 'whatsapp';
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
  /** Email subject. Optional — drafts generated before the Mailing Agent existed lack one. */
  subject?: string;
  generatedAt: string;
  model: string;
  /** Set once actually emailed. Presence means a real message left the building. */
  sentAt?: string;
  sentTo?: string;
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

export type GformField = {
  entryId: string;
  title: string;
  /** Google's question-type code from FB_PUBLIC_LOAD_DATA_. */
  type: number;
  typeName: string;
  required: boolean;
  options?: string[];
};

export type GformPrefill = {
  trackerId: string;
  formTitle: string;
  /** The usp=pp_url link that opens the form with answers pre-populated. */
  prefillUrl: string;
  filled: Array<{ title: string; value: string }>;
  skipped: Array<{ title: string; reason: string }>;
  fieldCount: number;
  generatedAt: string;
  model: string;
};

/**
 * A matched WhatsApp group post with no application URL — the "mail your CV to
 * hr@x.com" / "DM me" shape, which is most of what these groups actually carry.
 * It can't enter the URL-keyed tracker, so it gets its own row and stays a lead.
 */
export type WhatsappLead = {
  id: string;
  /** Group subject line as the bridge saw it. */
  group: string;
  /** Sender's push name if WhatsApp exposed one. Never a phone number. */
  sender?: string;
  text: string;
  /** The title-equivalent surface the match was anchored on. */
  roleLine: string;
  matchedRole?: string;
  emails: string[];
  hasDmAsk: boolean;
  postedAt: string;
  status: 'new' | 'contacted' | 'skipped';
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
