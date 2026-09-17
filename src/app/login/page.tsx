import type { Metadata } from 'next'

import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: 'Sign in · TAE Finance',
}

/** Auth-sensitive: never statically cached. */
export const dynamic = 'force-dynamic'

export default async function LoginPage(props: PageProps<'/login'>) {
  const searchParams = await props.searchParams
  const raw = searchParams.redirectTo
  const redirectTo = typeof raw === 'string' ? raw : undefined

  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight">Toronto Academy of Education</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Finance operations — staff sign in
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <LoginForm redirectTo={redirectTo} />
        </div>

        <p className="mt-6 text-xs text-zinc-500">
          Accounts are provisioned by an administrator. There is no self-service sign-up.
        </p>
      </div>
    </div>
  )
}
