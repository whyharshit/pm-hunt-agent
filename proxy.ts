import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  // Cookie set by a previous ?key= visit. In-app browsers (Telegram/WhatsApp webviews)
  // render the 401 body instead of showing a Basic-Auth prompt, so a login link that
  // plants a cookie is the only way in from there.
  if (request.cookies.get('dash_key')?.value === password) return NextResponse.next();

  // Login link: /?key=<password> → set the cookie, then redirect to the clean URL.
  const key = request.nextUrl.searchParams.get('key');
  if (key === password) {
    const url = request.nextUrl.clone();
    url.searchParams.delete('key');
    const res = NextResponse.redirect(url);
    res.cookies.set('dash_key', password, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    });
    return res;
  }

  const auth = request.headers.get('authorization');
  if (auth?.startsWith('Basic ')) {
    const decoded = atob(auth.slice('Basic '.length));
    const sep = decoded.indexOf(':');
    const got = sep === -1 ? decoded : decoded.slice(sep + 1);
    if (got === password) return NextResponse.next();
  }

  return new NextResponse('Authentication required. Open /?key=<dashboard password> to log in.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="PM Hunt Agent"' },
  });
}

export const config = {
  // ⚠️ EVERY dashboard route must be listed here. A route left off is PUBLIC — /funding and
  // /jobs were added to this list the same day they were created for exactly that reason, and
  // /paste both sends email and spends Hunter credits, so it is the worst one to forget.
  matcher: [
    '/',
    // /mail lists real recruiter addresses and who has answered. Added with the route, in the
    // same commit, for the reason written above.
    '/mail',
    // Names, profile links and who accepted. Same rule, same commit.
    '/linkedin',
    '/funding',
    '/jobs',
    '/paste',
    '/database',
    '/api/contacts',
    '/download/:path*',
  ],
  // ⚠️ MACHINE ENDPOINTS ARE DELIBERATELY ABSENT AND MUST STAY ABSENT. /api/whatsapp/ingest,
  // /api/telegram/webhook and /api/linkedin/notify are called by a bridge, by Telegram and by
  // the user's phone — none of which can answer a Basic-Auth prompt. Each carries its own
  // bearer secret and fails CLOSED when that secret is unset, which is the right gate for a
  // machine. Adding one of them here does not harden it; it silently breaks it.
};
