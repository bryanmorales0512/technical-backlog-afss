import { getToken } from 'next-auth/jwt'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Next's image optimizer in standalone output fetches local /public files
// via an internal HTTP request that carries no session cookie, so gating
// them behind auth made every next/image-optimized asset fail with "not a
// valid image". Listed explicitly (not by extension) so this can't
// accidentally exempt a future unrelated route sharing one of these
// extensions.
const PUBLIC_ASSET_PATHS = new Set([
  '/logo-evacuation.png', '/logo-fire-audits.png',
  '/file.svg', '/globe.svg', '/next.svg', '/vercel.svg', '/window.svg',
])

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_ASSET_PATHS.has(pathname)) {
    return NextResponse.next()
  }

  // Pass through NextAuth internals, the login page, and the cache warmup
  // endpoint (pinged by Cloud Scheduler every few minutes so SimPRO data stays
  // fresh without anyone visiting; warmAll/warmTechSupport dedupe + respect
  // TTLs, so unauthenticated hits cannot amplify SimPRO API traffic)
  if (pathname.startsWith('/api/auth') || pathname === '/login' || pathname === '/api/warmup') {
    return NextResponse.next()
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })

  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', req.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
