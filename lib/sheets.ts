import { createSign } from 'node:crypto';

/**
 * Append-only tracker in a Google Sheet, written via a service account (JWT bearer grant,
 * server-to-server — no interactive OAuth, no refresh token to babysit).
 *
 * Deliberately no `googleapis` dependency: that package pulls in a large dependency tree for
 * what is here a single REST call. `crypto.createSign` signs the JWT and `fetch` does the rest.
 *
 * A row is appended AFTER a real send succeeds and never blocks or undoes one — see the call
 * sites in lib/autosend.ts and lib/job-autosend.ts. An email that went out is the fact of
 * record; a spreadsheet that failed to log it is a inconvenience, not a reason to have not sent.
 */

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function sheetsConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      process.env.GOOGLE_SHEET_ID
  );
}

/** Env vars store the PEM with literal `\n` escapes — real newlines break most .env tooling. */
function privateKey(): string {
  return (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL!;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: email,
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      exp: now + 3600,
      iat: now,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  signer.end();
  const signature = base64url(signer.sign(privateKey()));
  const jwt = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

const TAB = 'Applications';

/**
 * One row: [date, time (IST), pipeline, company, title, recipient, status, url].
 *
 * No-ops silently when Sheets isn't configured yet, so this can be wired into every send path
 * before the service account exists without gating anything on it.
 */
export async function appendTrackerRow(row: (string | number)[]): Promise<void> {
  if (!sheetsConfigured()) return;
  const token = await getAccessToken();
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(TAB)}!A:H:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) {
    throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
  }
}

function istTimestamp(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    date: ist.toISOString().slice(0, 10),
    time: ist.toISOString().slice(11, 19) + ' IST',
  };
}

/** Logs one sent job application. Never throws — a logging failure must not look like a send failure. */
export async function logJobApplication(row: {
  sentAt: string;
  company: string;
  title: string;
  to: string;
  url: string;
}): Promise<void> {
  try {
    const { date, time } = istTimestamp(row.sentAt);
    await appendTrackerRow([date, time, 'job application', row.company, row.title, row.to, 'sent', row.url]);
  } catch (e) {
    console.error('[sheets] logJobApplication failed:', (e as Error).message);
  }
}

/** Logs one sent founder cold-outreach email. Never throws, for the same reason. */
export async function logFounderOutreach(row: {
  sentAt: string;
  company: string;
  to: string;
  url?: string;
}): Promise<void> {
  try {
    const { date, time } = istTimestamp(row.sentAt);
    await appendTrackerRow([
      date,
      time,
      'founder outreach',
      row.company,
      '',
      row.to,
      'sent',
      row.url ?? '',
    ]);
  } catch (e) {
    console.error('[sheets] logFounderOutreach failed:', (e as Error).message);
  }
}
