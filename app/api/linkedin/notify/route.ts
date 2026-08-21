import { classifyLinkedInText } from '@/lib/linkedin-mail';
import { recordAcceptance } from '@/lib/linkedin';

export const dynamic = 'force-dynamic';

/**
 * The phone relay: an Android notification listener posts LinkedIn's own push text here.
 *
 * WHY THIS EXISTS. LinkedIn emails only SOME acceptances. Measured on three real ones,
 * 20-22 Aug 2026: one arrived by mail, two produced nothing but a phone notification. The
 * "Invitations to connect" category HAS email switched on — its frequency is "LinkedIn
 * recommended", which means LinkedIn decides per event whether to bother, and there is no
 * setting that forces one email per acceptance reliably. The push, by contrast, fires every
 * time. So the phone sees events the mailbox never will, and this is how it tells us.
 *
 * The alternative sources and why they are not enough on their own: the connections CSV export
 * is complete but manual (the user's words: "very tiring"), and scraping with a session cookie
 * is against LinkedIn's terms. This is the user's own device relaying a notification it already
 * received — nothing is scraped and no credential of LinkedIn's is involved.
 *
 * ⚠️ THE BEARER SECRET IS THE ONLY THING PROVING THIS IS REAL. The email path can check a
 * From header; there is no equivalent here, so `classifyLinkedInText` is called WITHOUT a
 * sender gate and the secret carries the whole burden. It fails CLOSED: no secret configured
 * means the endpoint is off, exactly as /api/whatsapp/ingest does it.
 */

/** Longer than any notification LinkedIn writes; a body past this is not one. */
const MAX_TEXT = 500;

type Body = { title?: unknown; text?: unknown };

export async function POST(request: Request) {
  const secret = process.env.LINKEDIN_NOTIFY_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: 'LINKEDIN_NOTIFY_SECRET is not set — the phone relay is disabled' },
      { status: 503 }
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ⚠️ THREE SHAPES ACCEPTED, ON PURPOSE. The client here is a macro on a phone, built by hand
  // in a GUI, and the commonest way that setup fails is a quoting detail: a notification
  // containing an apostrophe breaks hand-written JSON, and MacroDroid does no escaping. So JSON,
  // form-encoding and plain query parameters all work, and a body that fails to parse falls back
  // to the query string rather than 400-ing at somebody holding a phone.
  const url = new URL(request.url);
  const raw = await request.text();
  const body: Body = {};
  const type = request.headers.get('content-type') ?? '';
  if (raw && type.includes('json')) {
    try {
      Object.assign(body, JSON.parse(raw) as Body);
    } catch {
      // fall through to the query string
    }
  } else if (raw && type.includes('form-urlencoded')) {
    const form = new URLSearchParams(raw);
    body.title = form.get('title') ?? undefined;
    body.text = form.get('text') ?? undefined;
  } else if (raw) {
    // A plain-text body is the whole notification.
    body.text = raw;
  }
  body.title ??= url.searchParams.get('title') ?? undefined;
  body.text ??= url.searchParams.get('text') ?? undefined;

  const title = typeof body.title === 'string' ? body.title.slice(0, MAX_TEXT) : '';
  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT) : '';
  if (!title && !text) {
    return Response.json({ ok: false, error: 'send {title, text} from the notification' }, { status: 400 });
  }

  // ⚠️ ORDER MATTERS. Android splits a notification into a title and a body, and LinkedIn uses
  // both shapes: sometimes the whole sentence is in the text ("Kajol accepted your invitation"),
  // sometimes the name is the title and the verb is the text ("Kajol Sharma" / "accepted your
  // invitation. Explore their network"). The text is tried FIRST because when it carries the
  // whole sentence, gluing the title on the front would make the app name part of the person's
  // name — "LinkedIn Kajol accepted your invitation" reads as somebody called "LinkedIn Kajol".
  const candidates = [text, `${title} ${text}`.trim(), title].filter(Boolean);

  // ⚠️ THE COMMONEST SETUP MISTAKE, ANSWERED IN THE RESPONSE ITSELF. MacroDroid substitutes
  // magic text written in SQUARE brackets — `[not_title]`, `[notification]` — and its picker
  // button is drawn with curly braces, so `{not_title}` gets typed and sent as those literal
  // characters. That produced a cheerful 200 saying "not an acceptance", which is true and
  // useless. Now the phone is told exactly what is wrong, on the phone, where the person
  // debugging it is standing.
  const unsubstituted = /[{[]\s*(not_title|notification|not_text|notification_title|notification_text)\s*[}\]]/i;
  const combined = `${title} ${text}`;
  if (unsubstituted.test(combined)) {
    return Response.json(
      {
        ok: false,
        error: 'magic text was sent literally, so the notification never reached us',
        got: combined.trim().slice(0, 120),
        fix: 'MacroDroid needs SQUARE brackets: [not_title] [notification]. Its picker button is drawn with curly braces, but the syntax is square.',
      },
      { status: 400 }
    );
  }

  // ⚠️ LOGGED, BECAUSE THE CLIENT CANNOT BE DEBUGGED FROM HERE. The caller is a macro on a
  // phone; when it misfires, the only evidence is whatever MacroDroid chose to show on a 4-inch
  // screen. `vercel logs` can read this line, so "did the magic text resolve?" and "what did the
  // parser make of it?" are answerable without asking the person holding the phone to read a
  // JSON response back. The name is the user's own data in the user's own log.
  console.log(
    `[linkedin/notify] title=${JSON.stringify(title)} text=${JSON.stringify(text)} ` +
      `kinds=${candidates.map((c) => classifyLinkedInText(c).kind).join(',')}`
  );

  // ⚠️ `?dry=true` EXISTS BECAUSE THE SETUP IS TESTED BY A HUMAN ON A PHONE. MacroDroid's own
  // "Test actions" button fires the real request, so without this every rehearsal writes a row
  // that then has to be deleted by hand — which is exactly what happened while this endpoint was
  // being built ("D'Souza"). It parses and reports, and touches nothing.
  const dryRun = url.searchParams.get('dry') === 'true';

  for (const candidate of candidates) {
    const event = classifyLinkedInText(candidate);
    if (event.kind !== 'accepted' || !event.name) continue;

    if (dryRun) {
      return Response.json({
        ok: true,
        dryRun: true,
        wouldRecord: event.name,
        note: 'nothing was written — drop ?dry=true when the macro is working',
      });
    }

    // `new Date()`, not a timestamp from the phone: a push is relayed within seconds of the
    // event, and a clock we do not control is a worse answer than the one we do.
    const { invite, isNew, job } = await recordAcceptance({
      name: event.name,
      at: new Date().toISOString(),
      via: 'push',
    });
    return Response.json({
      ok: true,
      recorded: invite.name,
      // false on a repeat, which is normal: Android re-posts a notification when it updates,
      // and the row is keyed by person so the second one changes nothing.
      isNew,
      ...(job ? { matchedJob: invite.jobLabel } : {}),
    });
  }

  // Not an acceptance. Reported plainly rather than as an error: if the macro is scoped a
  // little wider than it should be, this is the answer, and it should be readable in
  // MacroDroid's own log without anybody guessing.
  const kinds = candidates.map((c) => classifyLinkedInText(c).kind);
  return Response.json({
    ok: true,
    ...(dryRun ? { dryRun: true } : {}),
    recorded: null,
    kinds,
    note: 'not an acceptance notification',
  });
}

/** A GET so the setup can be tested from a browser without a body. */
export async function GET() {
  const configured = Boolean(process.env.LINKEDIN_NOTIFY_SECRET);
  return Response.json({
    ok: true,
    configured,
    usage: 'POST {"title": "...", "text": "..."} with Authorization: Bearer <LINKEDIN_NOTIFY_SECRET>',
  });
}
