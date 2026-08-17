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
    | 'apify'
    // Public Telegram job channels via t.me/s/ previews. Deliberately NOT 'telegram' —
    // that reads as the Telegram *intake* agent (DM → tracker), a different thing.
    | 'tgchannel'
    // The three free JSON boards (lib/sources/boards.ts).
    | 'himalayas'
    | 'remotive'
    | 'jobicy'
    // workatastartup.com rendered through Firecrawl (lib/sources/firecrawl.ts).
    | 'waas'
    /**
     * A hiring post the user pasted in by hand on /paste. Stored as a Job rather than given
     * its own type so it inherits the contact lookup, the draft, the sender and the follow-up
     * sequence unchanged — a pasted row and a discovered one are the same thing downstream.
     */
    | 'paste';
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl?: string;
  postedAt: Date;
  tags: string[];
  description?: string;
  salary?: string;
  /**
   * Outreach state. OPTIONAL because every job stored before 2026-08-17 predates job outreach
   * and has no status at all — absent is read as 'new' everywhere, so old rows join the queue
   * instead of being stranded outside it.
   */
  status?: 'new' | 'contacted' | 'skipped';
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

/**
 * One message that actually left the building, appended and never rewritten.
 *
 * `FundingOutreach.sentAt` is a single scalar that a re-send overwrites, so it cannot record
 * a sequence — and a sent draft is the record of what a founder received, so it must not be
 * made to lie about the first touch. Sends accumulate here instead.
 */
export type OutreachSend = {
  at: string;
  to: string;
  kind: 'initial' | 'followup-1' | 'followup-2' | 'followup-3';
  subject: string;
  /**
   * RFC Message-ID of this message. Threads the NEXT touch onto this one via In-Reply-To.
   * Optional because sends made before sequences existed have to recover it from Gmail's
   * Sent Mail, and that recovery is allowed to fail.
   */
  messageId?: string;
};

/**
 * The follow-up state machine for one funding row: up to three bumps after the initial
 * email, stopping the moment the founder replies or the address bounces.
 *
 * `company`, `to`, `greeted` and `subject` are denormalised on purpose. A follow-up fires up
 * to 24 days after the first email, by which time the funding row may have aged out of the
 * 200-row read window or been deleted — the sequence must be able to send without reading
 * anything else.
 */
export type OutreachSequence = {
  /** Same id as the row it came from — a funding row, or since 2026-08-17 a job row. */
  id: string;
  /**
   * Which pipeline opened this sequence, and therefore which follow-up copy it gets.
   *
   * OPTIONAL, and absent means 'funding': every sequence written before job outreach existed
   * came from the funding sender. Without this the job sends would inherit the founder
   * follow-ups, whose third touch says "Congratulations again on the raise" — to somebody who
   * posted an internship and never raised anything.
   */
  kind?: 'funding' | 'job';
  company: string;
  /** The one address this sequence talks to. A sequence never switches recipient. */
  to: string;
  /** First name the copy opens with, so follow-ups greet whoever the initial email did. */
  greeted: string;
  /** The initial subject. Follow-ups go out as "Re: <subject>" to sit in the same thread. */
  subject: string;
  /** Message-ID of the initial send, anchoring the References chain. */
  rootMessageId?: string;
  sends: OutreachSend[];
  /** Follow-ups completed. 3 means the sequence is spent. */
  step: 0 | 1 | 2 | 3;
  /** When the next follow-up is due. Absent once the sequence closes. */
  nextDueAt?: string;
  state: 'active' | 'replied' | 'bounced' | 'done' | 'stopped';
  closedAt?: string;
  closedReason?: string;
};

export type ContactPerson = {
  name: string;
  title?: string;
};

export type ContactEmail = {
  address: string;
  /** Page the address was literally found on. Addresses are never inferred or guessed. */
  foundOn: string;
  /**
   * Whose address this is, when the source told us. Without it the outreach can only ever
   * greet `founders[0]`, which is wrong the moment it sends to anyone else — and sending to
   * a non-founder is now allowed (founder first, employee as fallback).
   */
  person?: string;
  /** Their role, e.g. "Co-founder & CEO", "Head of Growth". Used to prefer decision-makers. */
  title?: string;
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

/**
 * Who to write to about a discovered JOB, and where that address came from.
 *
 * Deliberately its own type rather than a reuse of `FundingContact`. A funding row's contact
 * is "the founder of the company that raised", found by reading an article; a job row's is
 * "whoever posted this role", and the best case is that they wrote the address into the post
 * themselves. `founders` would be an actively misleading field name here, and provenance
 * ranking differs: an address lifted from the post body is the BEST kind on a job row and the
 * worst kind on a funding row.
 */
export type JobContact = {
  /** Same id as the job row. */
  id: string;
  people: ContactPerson[];
  emails: ContactEmail[];
  /** The company's own domain, once something has established it. */
  website?: string;
  foundAt: string;
  /** `post`, `hunter.io`, `added by hand` — how this contact was arrived at. */
  model: string;
  /** Why a lookup came back thin, shown on the dashboard row. */
  note?: string;
};

/** The drafted application email for a job row. Mirrors FundingOutreach; see lib/job-outreach-template.ts. */
export type JobOutreach = {
  id: string;
  subject: string;
  text: string;
  generatedAt: string;
  model: string;
  /** Set once actually emailed. Presence means a real message left the building. */
  sentAt?: string;
  sentTo?: string;
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
