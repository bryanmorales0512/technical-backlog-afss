import type { NextAuthOptions } from 'next-auth'
import GoogleProvider from 'next-auth/providers/google'
import { google } from 'googleapis'

const ALLOWED_GROUP = 'technicalafss-deployment@redadair.com.au'

async function checkGroupMembership(email: string): Promise<boolean> {
  const serviceAccountEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n')
  const adminEmail = process.env.GOOGLE_ADMIN_EMAIL

  if (!serviceAccountEmail || !privateKey || !adminEmail) {
    console.error('[auth] Service account not configured — denying access')
    return false
  }

  const auth = new google.auth.JWT({
    email: serviceAccountEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/admin.directory.group.member.readonly'],
    subject: adminEmail,
  })

  const adminSDK = google.admin({ version: 'directory_v1', auth })
  try {
    const res = await (adminSDK.members.hasMember({
      groupKey: ALLOWED_GROUP,
      memberKey: email,
    }) as Promise<{ data: { isMember?: boolean } }>)
    return res.data.isMember === true
  } catch (err: unknown) {
    // 404 = email not in group (not an error)
    if ((err as { code?: number }).code === 404) return false
    throw err
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false
      try {
        const allowed = await checkGroupMembership(user.email)
        if (!allowed) console.warn(`[auth] Access denied: ${user.email} is not in ${ALLOWED_GROUP}`)
        return allowed
      } catch (err) {
        console.error('[auth] Group membership check failed:', err)
        return false
      }
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
}
