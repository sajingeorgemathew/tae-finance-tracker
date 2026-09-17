import Link from 'next/link'
import { redirect } from 'next/navigation'

import { getUser } from '@/lib/auth'

/** Depends on the session cookie, so it must never be statically cached. */
export const dynamic = 'force-dynamic'

export default async function Home() {
  const user = await getUser().catch(() => null)

  if (user) {
    redirect('/dashboard')
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-md text-center">
        <h1 className="text-lg font-semibold tracking-tight">Toronto Academy of Education</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Internal finance operations system.
        </p>
        <Link
          href="/login"
          className="mt-8 inline-block rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Sign in
        </Link>
      </div>
    </div>
  )
}
