/**
 * One-page "what is this and how do I use it" guide PDF.
 * Run: npx tsx scripts/make-guide-pdf.tsx  →  docs/Intern-Agent-Guide.pdf
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Document, Page, Text, View, StyleSheet, renderToBuffer, Link } from '@react-pdf/renderer';

const ACCENT = '#1a56db';
const INK = '#1f2328';
const MUTED = '#57606a';
const RULE = '#d0d7de';

const styles = StyleSheet.create({
  page: {
    paddingTop: 34,
    paddingBottom: 30,
    paddingHorizontal: 40,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: INK,
    lineHeight: 1.45,
  },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: ACCENT, lineHeight: 1.2, marginBottom: 4 },
  tagline: { fontSize: 10, color: MUTED, marginBottom: 10 },
  h2: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: ACCENT,
    marginTop: 12,
    marginBottom: 5,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: RULE,
  },
  accessBox: {
    backgroundColor: '#f0f4ff',
    borderRadius: 4,
    padding: 8,
    marginTop: 2,
  },
  mono: { fontFamily: 'Courier', fontSize: 8.5 },
  agentRow: { flexDirection: 'row', marginBottom: 4 },
  agentName: { width: 92, fontFamily: 'Helvetica-Bold' },
  agentDesc: { flex: 1 },
  bullet: { flexDirection: 'row', marginBottom: 2.5 },
  bulletMark: { width: 10, color: ACCENT },
  bulletText: { flex: 1 },
  flow: { fontSize: 9, marginBottom: 4 },
  footer: {
    position: 'absolute',
    bottom: 16,
    left: 40,
    right: 40,
    fontSize: 7.5,
    color: MUTED,
    textAlign: 'center',
  },
});

const B = ({ children }: { children: React.ReactNode }) => (
  <Text style={{ fontFamily: 'Helvetica-Bold' }}>{children}</Text>
);

function Agent({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.agentRow} wrap={false}>
      <Text style={styles.agentName}>{name}</Text>
      <Text style={styles.agentDesc}>{children}</Text>
    </View>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bullet} wrap={false}>
      <Text style={styles.bulletMark}>•</Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

const Guide = (
  <Document title="Intern Hunt Agent — Guide">
    <Page size="A4" style={styles.page}>
      <Text style={styles.title}>Intern Hunt Agent</Text>
      <Text style={styles.tagline}>
        A personal, 7-agent platform that finds internship leads, tailors your resume per posting,
        drafts the outreach, and pre-fills applications. It prepares everything — you always press
        the final Submit or Send.
      </Text>

      <Text style={styles.h2}>Open the dashboard</Text>
      <View style={styles.accessBox}>
        <Text>
          <B>One-tap login (sets a 1-year cookie):</B>
        </Text>
        <Link src="https://agent-rose-theta.vercel.app/?key=c04ca8d8c1c132c5" style={styles.mono}>
          https://agent-rose-theta.vercel.app/?key=c04ca8d8c1c132c5
        </Link>
        <Text style={{ marginTop: 3, color: MUTED }}>
          After the first visit, the plain URL works in that browser. Everything below happens on
          this one page — agent cards on top, tracked rows and leads below.
        </Text>
      </View>

      <Text style={styles.h2}>The 7 agents</Text>
      <Agent name="Discover">
        Scans RemoteOK, WeWorkRemotely and HN "Who's Hiring" daily at 09:00 UTC, or on the card's
        Run now button. Zero matches most days is honest — generic boards rarely carry these roles.
      </Agent>
      <Agent name="Telegram Intake">
        DM any job URL to the Telegram bot and it lands as a tracked row, colour-coded:{' '}
        <Text style={{ color: '#1a7f37', fontFamily: 'Helvetica-Bold' }}>green</Text> = Google
        Form, <Text style={{ color: '#9a6700', fontFamily: 'Helvetica-Bold' }}>yellow</Text> =
        known ATS (Lever / Greenhouse / Ashby / Workable),{' '}
        <Text style={{ color: '#cf222e', fontFamily: 'Helvetica-Bold' }}>red</Text> = manual. The
        dashboard's Add URL form does the same without Telegram.
      </Agent>
      <Agent name="Resume Tailorer">
        On a yellow row, click Tailor: it scrapes the job description and rewrites your resume
        bullets for it — never inventing facts — then gives you Download PDF (a tailored
        one-pager) and Copy blurb (a cold message under 200 characters). Takes 30–90 seconds.
      </Agent>
      <Agent name="Funding Tracker">
        Watches TechCrunch daily at 09:30 UTC for freshly funded startups — teams that are hiring
        before they post jobs. Per row: Find contact digs up founders and real published emails
        (never guessed), and Draft outreach writes a short note referencing the raise.
      </Agent>
      <Agent name="Mailing Agent">
        Sends a drafted outreach email to a harvested address and marks the row contacted.
        Currently off until the Resend email key is configured.
      </Agent>
      <Agent name="Form Pre-filler">
        On a green row, click Pre-fill form, then Open pre-filled form: your saved answers are
        already typed into the Google Form. You review, attach the resume file, and submit.
      </Agent>
      <Agent name="WhatsApp Watcher">
        A small bridge on your PC reads the job groups and channels you follow; matching posts
        become tracked rows or leads and ping you on Telegram. Start it with
        {'  '}
        <Text style={styles.mono}>cd D:\Intern\intern-agent\bridge; npm start</Text>
        {'  '}
        and keep the window open — it only sees posts made while running.
      </Agent>

      <Text style={styles.h2}>The flow, end to end</Text>
      <Text style={styles.flow}>
        A posting arrives (any source above) » tracked row on the dashboard » <B>Tailor</B> »
        tailored PDF + blurb » <B>Pre-fill form</B> or <B>Draft outreach</B> » <B>you submit</B>.
        Each row has a status dropdown (new / applied / skipped…) so the dashboard doubles as your
        application tracker.
      </Text>

      <Text style={styles.h2}>Ground rules it never breaks</Text>
      <Bullet>
        <B>Nothing is ever auto-submitted or auto-sent.</B> Every application and email has a human
        click behind it.
      </Bullet>
      <Bullet>
        <B>Emails are found, never fabricated.</B> An address is only used if it was literally
        published on the company's own site.
      </Bullet>
      <Bullet>
        <B>Resume facts are preserved.</B> Tailoring reorders and rephrases your real bullets; it
        cannot invent experience or numbers.
      </Bullet>

      <Text style={styles.footer}>
        Intern Hunt Agent · agent-rose-theta.vercel.app · guide generated{' '}
        {new Date().toLocaleDateString('en-CA')}
      </Text>
    </Page>
  </Document>
);

async function main() {
  const out = resolve(__dirname, '../docs/Intern-Agent-Guide.pdf');
  mkdirSync(resolve(__dirname, '../docs'), { recursive: true });
  const buf = await renderToBuffer(Guide);
  writeFileSync(out, buf);
  console.log(`wrote ${out} (${(buf.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
