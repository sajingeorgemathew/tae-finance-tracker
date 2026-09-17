import Link from 'next/link'
import type { ReactNode } from 'react'

import { signOut } from '@/app/login/actions'

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/finance', label: 'Finance Tracker' },
  { href: '/settings', label: 'Settings' },
] as const

/** Minimal internal-tool chrome: title bar, nav, signed-in user, sign out. */
export function AppShell({
  children,
  userEmail,
}: {
  children: ReactNode
  userEmail?: string | null
}) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-zinc-50 dark:bg-black">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Toronto Academy of Education
            <span className="ml-2 font-normal text-zinc-500">Finance</span>
          </Link>

          <nav className="flex items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {userEmail ? (
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-zinc-500">{userEmail}</span>
              <form action={signOut}>
                <button
                  type="submit"
                  className="rounded-md border border-zinc-300 px-2.5 py-1 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                >
                  Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>

      <footer className="border-t border-zinc-200 px-6 py-4 text-xs text-zinc-500 dark:border-zinc-800">
        Internal finance system. Handle student financial records accordingly.
      </footer>
    </div>
  )
}
