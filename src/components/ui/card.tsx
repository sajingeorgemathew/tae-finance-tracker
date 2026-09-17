import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{children}</h2>
}

export function CardDescription({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{children}</p>
}
