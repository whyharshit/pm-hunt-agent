/**
 * LinkedIn's own connections export — the tracker's authoritative input.
 *
 * ⚠️ WHY THIS EXISTS AND THE EMAIL PATH DOES NOT CARRY THE FEATURE. Measured 2026-08-21/22 on
 * two real acceptances: the user sent two invitations, both friends accepted, and **no email
 * was ever sent** — only push notifications to the phone, which leave no trace anything can
 * read. The mailbox was searched over three days across All Mail and Spam by sender, by subject
 * and by body: nothing. LinkedIn only emails "X accepted your invitation" when the EMAIL
 * channel is switched on for that notification category, and for anyone using the mobile app it
 * is off by default. A forward cannot forward mail that was never sent.
 *
 * So `lib/linkedin-mail.ts` stays — it costs nothing, it is pinned, and it starts contributing
 * the day those emails are enabled — but the input that actually works today is
 * **Settings → Data privacy → Get a copy of your data → Connections**, which LinkedIn delivers
 * as a CSV holding every connection with the date it was made. No scraping, no session cookie,
 * nothing against their terms: it is the user's own data, offered by LinkedIn for download.
 *
 * ⚠️ THE EXPORT IS DIRECTION-BLIND. It lists connections, not invitations, so it cannot say who
 * invited whom. A row whose invitation the user logged here keeps that date and gets a real
 * "accepted after 4d"; a row that appears only in the export is recorded as connected with no
 * invitation date, which is the honest reading.
 */

export type ConnectionRow = {
  name: string;
  profileUrl?: string;
  company?: string;
  position?: string;
  /** ISO date, midnight UTC — the export gives a day, not a time. */
  connectedOn: string;
};

export type ParsedConnections = {
  rows: ConnectionRow[];
  /** Data lines that could not be used, with the reason, capped for display. */
  skipped: Array<{ line: string; why: string }>;
  /** Set when the file was not a connections export at all. `rows` is empty then. */
  error?: string;
};

/**
 * One CSV line into fields, honouring quotes.
 *
 * Written out rather than split on commas because the columns that break that are exactly the
 * ones people have: "Jain, Aayush" in a name field, "Acme, Inc." as a company, and a Position
 * of "Founder, Product & Growth". A naive split silently shifts every later column, which would
 * put a company name in the date field and drop the row.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * The "Connected On" column, in every shape LinkedIn has used for it.
 *
 * ⚠️ MIDNIGHT UTC, DELIBERATELY. The export gives a DAY with no time, and inventing a time
 * would put a fake precision on the timeline next to real timestamps read from email headers.
 * Returns null rather than guessing when the text is not a date at all — a row with an
 * unreadable date is skipped and reported, never stored with today's date, which would claim
 * the connection was made the day of the import.
 */
export function parseConnectedOn(raw: string): string | null {
  const text = raw.trim().replace(/"/g, '');
  if (!text) return null;

  // "21 Aug 2026" / "21-Aug-2026" — the current format.
  const dmy = /^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s-]+(\d{2,4})$/.exec(text);
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return isoFrom(Number(dmy[3]), month, Number(dmy[1]));
  }

  // "Aug 21, 2026"
  const mdy = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(text);
  if (mdy) {
    const month = MONTHS[mdy[1].slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return isoFrom(Number(mdy[3]), month, Number(mdy[2]));
  }

  // "2026-08-21"
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return isoFrom(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  // "8/21/2026" — American order, which is what a US-locale export gives.
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (slash) return isoFrom(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));

  return null;
}

function isoFrom(year: number, monthIndex: number, day: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(y, monthIndex, day));
  if (Number.isNaN(+d)) return null;
  // Reject a rolled-over date ("31 Feb" becomes 3 March) rather than storing the wrong day.
  if (d.getUTCDate() !== day || d.getUTCMonth() !== monthIndex) return null;
  return d.toISOString();
}

/** Match a header cell to the column we want, tolerant of case and spacing. */
function headerIndex(header: string[], ...names: string[]): number {
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  for (const name of names) {
    const i = norm.indexOf(name.toLowerCase().replace(/[^a-z]/g, ''));
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Parse a Connections.csv.
 *
 * ⚠️ THE FILE DOES NOT START WITH ITS HEADER. LinkedIn puts a "Notes:" preamble and a quoted
 * paragraph about missing email addresses above it, with blank lines in between, and that
 * paragraph contains commas — so anything that assumes line 1 is the header parses the
 * disclaimer as a person. The header is found by looking for the row that actually names the
 * columns, wherever it is.
 */
export function parseConnectionsCsv(text: string): ParsedConnections {
  const skipped: ParsedConnections['skipped'] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let headerAt = -1;
  let header: string[] = [];
  for (let i = 0; i < Math.min(lines.length, 40); i += 1) {
    if (!/first\s*name/i.test(lines[i])) continue;
    const cells = splitCsvLine(lines[i]);
    if (headerIndex(cells, 'firstname') !== -1) {
      headerAt = i;
      header = cells;
      break;
    }
  }
  if (headerAt === -1) {
    return {
      rows: [],
      skipped,
      error:
        'No "First Name … Connected On" header row found. This should be the Connections.csv ' +
        'from LinkedIn → Settings → Data privacy → Get a copy of your data.',
    };
  }

  const iFirst = headerIndex(header, 'firstname');
  const iLast = headerIndex(header, 'lastname');
  const iUrl = headerIndex(header, 'url', 'profileurl');
  const iCompany = headerIndex(header, 'company');
  const iPosition = headerIndex(header, 'position');
  const iDate = headerIndex(header, 'connectedon', 'connected');

  if (iDate === -1) {
    return {
      rows: [],
      skipped,
      error: 'The header has no "Connected On" column, so no connection dates could be read.',
    };
  }

  const rows: ConnectionRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const name = [cells[iFirst] ?? '', iLast === -1 ? '' : cells[iLast] ?? '']
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) {
      skipped.push({ line: line.slice(0, 80), why: 'no name' });
      continue;
    }
    const connectedOn = parseConnectedOn(cells[iDate] ?? '');
    if (!connectedOn) {
      // ⚠️ SKIPPED, NOT DATED TODAY. A row stored with the import date would claim the
      // connection happened the day the file was uploaded.
      skipped.push({ line: name, why: `unreadable date "${(cells[iDate] ?? '').slice(0, 24)}"` });
      continue;
    }
    const url = iUrl === -1 ? '' : cells[iUrl] ?? '';
    rows.push({
      name,
      ...(url && /^https?:\/\//i.test(url) ? { profileUrl: url } : {}),
      ...(iCompany !== -1 && cells[iCompany] ? { company: cells[iCompany] } : {}),
      ...(iPosition !== -1 && cells[iPosition] ? { position: cells[iPosition] } : {}),
      connectedOn,
    });
  }

  return { rows, skipped };
}
