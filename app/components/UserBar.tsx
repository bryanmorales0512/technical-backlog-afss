'use client'
import { useSession, signOut } from 'next-auth/react'
import { usePathname } from 'next/navigation'

export default function UserBar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  if (!session || pathname === '/login') return null

  return (
    <div className="flex items-center justify-end gap-3 px-4 py-1.5 bg-gray-900 border-b border-gray-800 text-xs text-gray-400 min-w-0">
      <span className="truncate min-w-0">{session.user?.email}</span>
      <button
        onClick={() => signOut({ callbackUrl: '/login' })}
        className="text-gray-500 hover:text-white transition-colors cursor-pointer"
      >
        Sign out
      </button>
    </div>
  )
}
