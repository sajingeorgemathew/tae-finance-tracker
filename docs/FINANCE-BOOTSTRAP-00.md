# FINANCE-BOOTSTRAP-00 — Foundation

**Branch:** `feature/finance-bootstrap-00`
**Status:** complete, uncommitted

---

## 1. Ticket purpose

Stand up the foundation for the Toronto Academy of Education internal finance
operations system: a Next.js App Router application with Supabase
authentication, validated environment configuration, a protected application
shell, and a documented place for every subsystem that follows.

Foundation only. No finance schema, no workbook import, no receipts, no email.

## 2. Current project architecture

```
finance-tracker/
├── docs/
│   ├── FINANCE-BOOTSTRAP-00.md      this document
│   └── tickets/FINANCE-BOOTSTRAP-00 the original ticket
├── reference/                       source files — read-only, git-ignored
│   ├── README.md                    (the only tracked file here)
│   ├── finance-tracker.xlsx.xlsx
│   └── receipt-template.pdf.pdf
├── scripts/                         developer-run scripts (empty)
├── supabase/migrations/             SQL migrations (empty — no tables yet)
└── src/
    ├── proxy.ts                     Next 16 proxy (formerly middleware)
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx                 public landing → /dashboard if signed in
    │   ├── login/                   page + form + server actions
    │   ├── dashboard/page.tsx       protected
    │   ├── finance/page.tsx         protected
    │   ├── settings/page.tsx        protected
    │   └── api/health/route.ts      dev-only diagnostic
    ├── components/
    │   ├── finance/                 tracker-placeholder.tsx
    │   ├── receipts/                (empty)
    │   ├── email/                   (empty)
    │   └── ui/                      app-shell.tsx, card.tsx
    ├── lib/
    │   ├── env.ts                   public env schema (browser-safe)
    │   ├── env.server.ts            server-only env schema (secrets)
    │   ├── auth.ts                  requireUser / getUser
    │   ├── utils.ts                 cn()
    │   ├── supabase/                client.ts, server.ts, proxy.ts, health.ts
    │   └── finance/ receipts/ email/ excel/   (empty)
    └── types/                       (empty)
```

Layering rule: `app/` → `lib/` → Supabase. Anything holding a secret imports
`server-only`, which turns accidental client use into a build error.

## 3. Installed dependencies

**Runtime baseline:** Node v22.23.2, npm 10.9.8, Next.js 16.3.5, React 19.2.8,
TypeScript 5, Tailwind CSS 4.

| Package | Purpose |
| --- | --- |
| `@supabase/supabase-js`, `@supabase/ssr` | Database + auth, SSR cookie handling |
| `zod` | Environment and input validation |
| `date-fns` | Date handling for installments/reminders |
| `lucide-react`, `clsx`, `tailwind-merge` | UI primitives |
| `@tanstack/react-table`, `@tanstack/react-virtual` | Excel-style virtualised grid |
| `xlsx` | Workbook import and Excel export |
| `@react-pdf/renderer` | PDF receipt generation |
| `resend`, `@react-email/components` | Email delivery (installed, **not configured**) |
| `react-hook-form`, `@hookform/resolvers` | Forms |
| `server-only` | Build-time guard keeping server modules out of the client bundle |

`@supabase/auth-helpers-*` is deliberately **not** used — it is deprecated in
favour of `@supabase/ssr`.

## 4. Environment variable NAMES required

Read from `.env.local` (never committed, never printed):

| Name | Scope | Required |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | yes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser + server | yes (preferred) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | accepted as a legacy fallback; not present in this project |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | optional |
| `RESEND_API_KEY` | **server only** | optional (unused in this ticket) |
| `EMAIL_FROM` | **server only** | optional (unused in this ticket) |

`src/lib/env.ts` validates the public pair with Zod and accepts either the
publishable key or the legacy anon key. `src/lib/env.server.ts` validates the
secrets and is guarded by `server-only`; no secret is re-exported from
`env.ts`.

## 5. Supabase client setup

| File | Use |
| --- | --- |
| `src/lib/supabase/client.ts` | `createBrowserClient` for Client Components. Publishable key only. |
| `src/lib/supabase/server.ts` | `createServerClient` + `await cookies()` for Server Components, Actions and Route Handlers. Created per request, never cached. Also defines `createServiceRoleClient()`, unused in this ticket. |
| `src/lib/supabase/proxy.ts` | `updateSession()` — refreshes the auth session and performs an optimistic redirect. |
| `src/proxy.ts` | Next.js 16 entry point. Next 16 renamed `middleware.ts` to `proxy.ts`, so this project uses `proxy.ts`. |
| `src/lib/auth.ts` | `requireUser()` / `getUser()` — the real authorization check, calling `supabase.auth.getUser()` on the server. |

The proxy refreshes tokens and writes the cookies plus the cache headers
`@supabase/ssr` supplies with them, so a token refresh can never be cached and
served to another user. The proxy redirect is optimistic convenience only —
every protected page re-checks the user server-side.

## 6. Reference-file handling

`reference/` holds the two source files, with their original filenames
preserved exactly (including the doubled extensions):

- `finance-tracker.xlsx.xlsx`
- `receipt-template.pdf.pdf`

They were moved into the project root from the parent directory; their contents
were not altered. They are **git-ignored** — see §10 and `reference/README.md`.
Application code may only ever open them read-only, from server code.

## 7. Routes created

| Route | Auth | Notes |
| --- | --- | --- |
| `/` | public | Landing; redirects a signed-in user to `/dashboard`. |
| `/login` | public | Email/password sign-in. Redirects a signed-in user to `/dashboard`. |
| `/dashboard` | protected | Cards for Finance Tracker, Receipts, Payment Reminders, Exports / Backups, Settings. |
| `/finance` | protected | "Finance Tracker" plus disabled Batch / Program / Balance Due / Receipt Status / Reminder Status controls and a grid placeholder. |
| `/settings` | protected | Supabase connectivity status, signed-in account. |
| `/api/health` | dev-only | Returns `404` unless `NODE_ENV === 'development'`. |

Every protected route sets `export const dynamic = 'force-dynamic'`, so a page
rendered for one session can never be statically cached and served to another.

## 8. What was intentionally NOT implemented

- No finance, receipt or audit tables; `supabase/migrations/` is empty.
- No workbook import. Historical data will be imported AS-IS later; nothing was
  corrected, normalised, deduplicated or reconciled.
- No receipt generation and no change to receipt numbering rules.
- No email. `resend` is installed but never imported or configured.
- No reminders, no Excel export, no backups.
- No roles or permissions model — only "signed in" vs "not signed in".
- No commit or push. Nothing has been staged.

## 9. Local testing steps

```bash
cd finance-tracker
npm install
npm run lint
npm run typecheck
npm run build
npm run dev
```

Then check:

1. `http://localhost:3000/` — landing page with a Sign in link.
2. `http://localhost:3000/dashboard` — redirects to `/login?redirectTo=/dashboard`
   while signed out. Same for `/finance` and `/settings`.
3. `http://localhost:3000/login` — sign in with a Supabase user created in the
   Supabase dashboard (there is no self-service sign-up).
4. `http://localhost:3000/settings` — shows `Supabase: Connected`.
5. `http://localhost:3000/api/health` — JSON with the Supabase status and
   presence booleans for the server variables. Never returns a value.

## 10. Known issues / assumptions

1. **The workbook contains real student data.** `reference/finance-tracker.xlsx.xlsx`
   holds ~1,000 payment rows across 15 sheets with student IDs, first/last
   names, payer names and balances. `reference/*` is therefore git-ignored
   except its README. If the workbook must be versioned, use private encrypted
   storage, not this repository.
2. **Filenames have doubled extensions** (`.xlsx.xlsx`, `.pdf.pdf`). Preserved
   exactly as instructed; any import code must use these literal names.
3. **Project root is `Desktop/finance-tracker/finance-tracker/`** — the git
   repository, `package.json` and `.env.local` all live there. The outer
   `Desktop/finance-tracker/` directory is now just a container. `reference/`
   was moved inward to match.
4. **No `NEXT_PUBLIC_SUPABASE_ANON_KEY` is set**; the project uses the newer
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The legacy name is still accepted by
   `env.ts` so an older environment keeps working.
5. **Sign-in errors are deliberately generic** ("Invalid email or password.") so
   the form cannot be used to discover which accounts exist. Details go to the
   server log only.
6. **The health check probes a relation that does not exist** and treats
   PostgREST's "relation not found" response as proof of a reachable,
   authenticated project. Once real tables exist, point it at a cheap real
   query instead.
7. **`AGENTS.md` is generated by `next dev`** and re-appears if removed.
