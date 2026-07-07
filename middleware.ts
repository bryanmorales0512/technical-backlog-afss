import { getToken } from 'next-auth/jwt'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

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
