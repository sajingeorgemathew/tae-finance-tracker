import Link from 'next/link'
import type { Metadata } from 'next'

import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/ui/app-shell'
import { requireUser } from '@/lib/auth'

export const metadata: Metadata = {
  title: 'Dashboard · TAE Finance',
}

/** Authenticated: rendered per request, never statically cached. */
export const dynamic = 'force-dynamic'

/**
 * Sections of the finance system. Only the ones that already have a route are
 * linked — the rest are listed so the scope is visible, without pretending to
 * work.
 */
const SECTIONS = [
  {
    title: 'Finance Tracker',
    description:
      'Excel-style grid of batches, enrollments, installments and outstanding balances.',
    href: '/finance',
  },
  {
    title: 'Receipts',
    description: 'Generate individual or batch PDF receipts and track what has been sent.',
    href: null,
  },
  {
    title: 'Payment Reminders',
    description: 'Individual and batch reminders for outstanding balances.',
    href: null,
  },
  {
    title: 'Exports / Backups',
    description: 'Excel export and point-in-time backups of the finance records.',
    href: null,
  },
  {
    title: 'Settings',
    description: 'Environment status, connectivity and application configuration.',
    href: '/settings',
  },
] as const

export default async function DashboardPage() {
  const user = await requireUser('/dashboard')

  return (
    <AppShell userEmail={user.email}>
      <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Finance operations for Toronto Academy of Education.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((section) =>
          section.href ? (
            <Link
              key={section.title}
              href={section.href}
              className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
            >
              <Card className="h-full transition-colors hover:border-zinc-400 dark:hover:border-zinc-600">
                <CardTitle>{section.title}</CardTitle>
                <CardDescription>{section.description}</CardDescription>
              </Card>
            </Link>
          ) : (
            <Card key={section.title} className="h-full opacity-70">
              <CardTitle>{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Not yet available
              </p>
            </Card>
          ),
        )}
      </div>
    </AppShell>
  )
}
