# supabase/migrations

SQL migrations, applied in filename order.

| Migration | Ticket | Contents |
| --- | --- | --- |
| `20260917143000_finance_foundation.sql` | FINANCE-DATA-01 | Profiles/roles, programs, batches, students, finance records, installments, payments, receipts, delivery history, import batches, audit log, indexes, RLS |
| `20260917150000_initial_program_configuration.sql` | FINANCE-DATA-01 | The PSW and ECEA program rows — production configuration, upserted on `short_code` |

Authentication itself uses Supabase's built-in `auth` schema, which needs no
migration. The foundation migration does add one trigger on `auth.users`
(`on_auth_user_created`) so every sign-up gets a `viewer` profile.

## Applying a migration

The project is **not linked** to the hosted Supabase project, so migrations are
applied by hand — see `docs/FINANCE-DATA-01.md` for the full procedure and for
what to check afterwards. In short: open the Supabase SQL Editor and run each
migration in filename order.

Never run `supabase db reset` against the hosted project: it drops everything.

## Writing a migration

- One file per ticket, named `<timestamp>_<subject>.sql`.
- Idempotent where it is cheap (`if not exists`, `create or replace`,
  `drop policy if exists`), but never so defensive that a real error is hidden.
- No destructive statements. A column or table that must go gets its own
  reviewed migration.
- **There is no seed directory.** Configuration the application cannot run
  without is production data and belongs in a migration, upserted on a stable
  business key so re-running it is harmless. Sample or test data belongs in
  neither place.
- Money is `numeric(12,2)`. Instants are `timestamptz`; calendar days are `date`.
- Every new table enables RLS and documents its policies in the same file.
