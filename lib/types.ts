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
  /**
   * Who answered, when they answered, and how we recognised it.
   *
   * ⚠️ NOT DERIVABLE FROM `closedReason`, which is a sentence for a human. The address is
   * usually NOT `to` — an application to `careers@rovia.one` was answered from
   * `aayush.j@rovia.one` — and `at` is when THEY wrote, where `closedAt` is when a run
   * noticed. Those were seven hours apart on that thread, and the /mail timeline is unreadable
   * if it can only show the second one.
   *
   * Absent on sequences closed before 2026-08-21; the timeline falls back to `closedAt` plus
   * `closedReason` for those rather than guessing.
   */
  reply?: {
    from: string;
    /** When they wrote, off the message envelope. */
    at?: string;
    how: 'thread' | 'address' | 'colleague';
    /** When a follow-up run found it. */
    noticedAt: string;
  };
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
  /**
   * Contact details a human typed in on /paste, which no scraper can reach.
   *
   * Added 2026-08-18 so the pasted rows accumulate into a contact database rather than only
   * feeding one email each: plenty of posts put the address in an image, and the poster's
   * LinkedIn profile and phone number are worth keeping once found by hand even when the
   * application has already gone out.
   */
  linkedin?: string;
  phone?: string;
  foundAt: string;
  /** `post`, `hunter.io`, `added by hand` — how this contact was arrived at. */
  model: string;
  /** Why a lookup came back thin, shown on the dashboard row. */
  note?: string;
  /**
   * When the PAID Hunter lookup was settled for this row — either run, or established as
   * pointless because Hunter knows zero addresses on the domain. Presence means never pay
   * for this row again.
   *
   * ⚠️ Load-bearing against a credit leak. The paid lookup often comes back empty (small
   * Indian startups are thinly covered), and an empty result leaves the row looking exactly
   * like one that was never tried — so every subsequent pass would pay for the same domain
   * again. Harmless at 1 credit a day on a cron; not harmless behind a dashboard button a
   * human can press ten times against a pool of 100 a month.
   */
  hunterCheckedAt?: string;
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

/**
 * One LinkedIn invitation, and whether it was accepted.
 *
 * ⚠️ ACCEPTANCE IS THE ONLY STATE LINKEDIN WILL TELL US ABOUT, and only by email. There is no
 * API for invitations at any tier, and a PENDING invitation appears nowhere except LinkedIn's
 * own "Sent" page — so `invitedAt` is always something a human recorded, while `acceptedAt` can
 * come from either the notification mail (lib/linkedin-mail.ts) or a human. A row can exist
 * with an acceptance and no invitation date: the mail arrives whether or not anybody logged the
 * invite, and dropping it would be losing the only fact we actually have.
 */
export type LinkedInInvite = {
  /** `li:<name with punctuation and case removed>`, so the same person is one row. */
  id: string;
  name: string;
  profileUrl?: string;
  /** Anything the user wants on the row: their company, where the invite came from. */
  note?: string;
  /** When the user says they sent it. Absent when only the acceptance is known. */
  invitedAt?: string;
  /** When LinkedIn said they accepted, off the notification's date. */
  acceptedAt?: string;
  /**
   * Where the acceptance came from. `export` is the LinkedIn connections CSV, which is the
   * only source that works today — LinkedIn sent NO email for two real acceptances on
   * 2026-08-21/22, only phone notifications. See lib/linkedin-csv.ts.
   */
  acceptedVia?: 'email' | 'manual' | 'export';
  /** The notification that proved it — an audit trail, and it keeps re-scans idempotent. */
  messageId?: string;
  /** A discovered job row this person posted, matched by name. */
  jobId?: string;
  /** How that row reads, captured at link time so a deleted job leaves a legible trace. */
  jobLabel?: string;
  createdAt: string;
  updatedAt: string;
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
