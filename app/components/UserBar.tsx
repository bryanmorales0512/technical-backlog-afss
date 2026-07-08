'use client'
import { useSession, signOut } from 'next-auth/react'
import { usePathname } from 'next/navigation'
import Image from 'next/image'

export default function UserBar() {
  const { data: session } = useSession()
  const pathname = usePathname()

  if (!session || pathname === '/login') return null

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-1.5 bg-white border-b border-gray-200 text-xs text-gray-500 min-w-0">
      <div />
      <div className="flex items-center gap-4 justify-self-center">
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
      <div className="flex items-center gap-3 min-w-0 justify-self-end">
        <span className="truncate min-w-0">{session.user?.email}</span>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="text-gray-500 hover:text-gray-900 transition-colors cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
