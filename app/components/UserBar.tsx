'use client'
import { useSession, signOut } from 'next-auth/react'
import { usePathname } from 'next/navigation'
import Image from 'next/image'

export default function UserBar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  if (!session || pathname === '/login') return null

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-gray-900 border-b border-gray-800 text-xs text-gray-400 min-w-0">
      <div className="flex items-center gap-4">
        <Image
          src="/logo-evacuation.png"
          alt="Adair Evacuation Consultants"
          width={140}
          height={40}
          className="h-9 w-auto object-contain"
        />
        <Image
          src="/logo-fire-audits.png"
          alt="Adair Fire Audits & Certification"
          width={120}
          height={40}
          className="h-8 w-auto object-contain"
        />
      </div>
      <div className="flex items-center gap-3 min-w-0">
        <span className="truncate min-w-0">{session.user?.email}</span>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="text-gray-500 hover:text-white transition-colors cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
