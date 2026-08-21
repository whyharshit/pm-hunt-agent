/**
 * IMAP smoke test — READ ONLY, sends nothing, marks nothing as read.
 *   npx tsx --env-file=.env.local scripts/check-imap.mts [address-to-look-for]
 *
 * Answers the one question the follow-up pass depends on: can this App Password read the
 * mailbox? If it cannot, `runFollowUps` refuses to send at all, so a failure here is the
 * difference between follow-ups going out and the whole feature sitting idle.
 *
 * Pass an address to also exercise the reply and bounce searches against it. Use one you
 * have actually received mail from, so a `true` proves the search works rather than the
 * connection alone.
 */
import {
  colleagueDomainFor,
  findReply,
  findSentMessageId,
  hasBounceFor,
  hasReplyFrom,
  imapConfigured,
  withImap,
} from '../lib/imap';

const probe = process.argv[2];

console.log('imapConfigured():', imapConfigured());
console.log('account:', process.env.GMAIL_USER ?? '(GMAIL_USER unset)');

if (!imapConfigured()) {
  console.error('\nSet GMAIL_USER + GMAIL_APP_PASSWORD in .env.local first.');
  process.exit(1);
}

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

try {
  await withImap(async (client) => {
    const inbox = await client.mailboxOpen('INBOX', { readOnly: true });
    console.log('INBOX opened ✅ ·', inbox.exists, 'messages');

    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent');
    console.log('sent mailbox:', sent ? sent.path : 'NOT FOUND (will fall back to [Gmail]/Sent Mail)');

    if (probe) {
      console.log(`\nsearching the last 30 days for ${probe}:`);
      // The address-only search, which is what the follow-up pass used to ask. Kept visible on
      // purpose: on a shared inbox it answers `false` while a person behind that inbox has
      // already replied, and seeing the two answers side by side is the whole lesson.
      console.log('  [address only] reply from them:', await hasReplyFrom(client, probe, since));
      console.log('  bounce for them:', await hasBounceFor(client, probe, since));

      const rootId = await findSentMessageId(client, probe, new Date());
      console.log('  our last Message-ID to them:', rootId ?? 'none found today');
      console.log(
        '  colleague rule:',
        colleagueDomainFor(probe) ? `any sender @${colleagueDomainFor(probe)} counts` : 'not applied'
      );

      // What `runFollowUps` actually asks. A hit here with `how` other than 'address' is a
      // reply the old check could not see.
      const hit = await findReply(client, {
        to: probe,
        messageIds: rootId ? [rootId] : [],
        since,
      });
      console.log('  [findReply] replied:', hit ? `${hit.from} (${hit.how})` : 'no');
    }
  });
  console.log('\nIMAP OK ✅ — follow-ups can tell who replied.');
} catch (e) {
  console.error('\nIMAP FAILED:', (e as Error).message);
  process.exit(1);
}
