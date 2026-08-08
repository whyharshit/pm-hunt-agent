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
  matcher: ['/', '/funding', '/jobs', '/download/:path*'],
};
