import type { Metadata } from 'next'

import { AppShell } from '@/components/ui/app-shell'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { requireUser } from '@/lib/auth'
import { checkSupabaseHealth } from '@/lib/supabase/health'

export const metadata: Metadata = {
  title: 'Settings · TAE Finance',
}

/** Authenticated + live connectivity check: never statically cached. */
export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const user = await requireUser('/settings')

  // Returns a status and a fixed label only. Internal error details stay in the
  // server logs.
  const health = await checkSupabaseHealth()
  const connected = health.status === 'connected'

  return (
    <AppShell userEmail={user.email}>
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Application configuration and system status.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>Connectivity</CardTitle>
          <div className="mt-3 flex items-center gap-2">
            <span
              aria-hidden
              className={
                connected
                  ? 'size-2 rounded-full bg-emerald-500'
                  : 'size-2 rounded-full bg-amber-500'
              }
            />
            <span className="text-sm font-medium">{health.label}</span>
          </div>
          <CardDescription>
            Checked server-side on each load using the publishable key only.
          </CardDescription>
        </Card>

        <Card>
          <CardTitle>Signed in as</CardTitle>
          <CardDescription>{user.email ?? 'Unknown account'}</CardDescription>
        </Card>

        <Card className="sm:col-span-2">
          <CardTitle>Not yet configured</CardTitle>
          <CardDescription>
            Email delivery, receipt numbering, reminder schedules and user roles are defined in
            later tickets.
          </CardDescription>
        </Card>
      </div>
    </AppShell>
  )
}
