# TAE Finance

Internal finance operations system for **Toronto Academy of Education**.

Staff-only application for tracking programme batches, enrollments,
installments and outstanding balances, generating and sending receipts,
issuing payment reminders, exporting Excel backups, and keeping an audit
history of it all.

This is an internal tool. It is not public-facing and is not indexed.

> ⚠️ **Do not modify anything in `reference/`.**
> It holds the original finance workbook and the receipt template — the source
> of truth this system is built from. Application code may open them read-only
> and must never write to them. They contain real student financial records and
> are excluded from Git. See [`reference/README.md`](reference/README.md).

## Status

Currently at **FINANCE-BOOTSTRAP-00** — foundation only. Authentication, the
application shell and the project structure exist; there is no finance schema,
no imported data, no receipts and no email yet. See
[`docs/FINANCE-BOOTSTRAP-00.md`](docs/FINANCE-BOOTSTRAP-00.md).

## Local startup

Requires Node 22+ and npm 10+.

```bash
npm install
npm run dev          # http://localhost:3000
```

`.env.local` must be present in the project root with the Supabase
configuration. Required variable **names**:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY    # or the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY               # optional, server-only, never sent to the browser
RESEND_API_KEY                          # optional, unused so far
EMAIL_FROM                              # optional, unused so far
```

Accounts are provisioned in the Supabase dashboard — there is no self-service
sign-up. Visit `/settings` to confirm `Supabase: Connected`.

Checks:

```bash
npm run lint
npm run typecheck
npm run build
```

## Architecture

- **Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS 4.**
- **Supabase** for authentication and the database, via `@supabase/ssr`
  (never the deprecated `auth-helpers` packages).
  - `src/lib/supabase/client.ts` — browser client, publishable key only
  - `src/lib/supabase/server.ts` — per-request server client
  - `src/proxy.ts` — Next 16 proxy; refreshes the auth session on every request
  - `src/lib/auth.ts` — `requireUser()`, the server-side authorization check
- **Environment validation** with Zod, split so secrets cannot leak:
  `src/lib/env.ts` is browser-safe; `src/lib/env.server.ts` is `server-only`.
- **Routes:** `/` and `/login` are public; `/dashboard`, `/finance` and
  `/settings` require a signed-in user and are always rendered dynamically so a
  session is never cached across users.
- **Subsystems** each have a home under `src/lib` and `src/components`
  (`finance`, `receipts`, `email`, `excel`), with a README describing what will
  live there.

```
src/app          routes
src/components   UI, grouped by subsystem
src/lib          domain logic, Supabase, env
src/types        shared types
scripts          developer-run scripts (import, export, codegen)
supabase/        migrations
reference/       read-only source files — git-ignored
docs/            ticket documentation
```
