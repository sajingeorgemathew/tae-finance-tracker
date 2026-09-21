# supabase/migrations

SQL migrations, applied in filename order.

| Migration | Ticket | Contents |
| --- | --- | --- |
| `20260917143000_finance_foundation.sql` | FINANCE-DATA-01 | Profiles/roles, programs, batches, students, finance records, installments, payments, receipts, delivery history, import batches, audit log, indexes, RLS |
| `20260917150000_initial_program_configuration.sql` | FINANCE-DATA-01 | The PSW and ECEA program rows — production configuration, upserted on `short_code` |
| `20260918120000_legacy_raw_json.sql` | FINANCE-IMPORT-02 | `legacy_raw_json` on students, finance records and installments |
| `20260918130000_import_exceptions.sql` | FINANCE-IMPORT-02 | `import_exceptions`: source rows preserved verbatim instead of normalized |
| `20260920120000_batch_finance_columns.sql` | FINANCE-COLUMN-MANIFEST-03A | `batch_finance_columns`: a batch's column layout — constraints, indexes, RLS, policies |
| `20260920120100_batch_finance_columns_legacy_manifest.sql` | FINANCE-COLUMN-MANIFEST-03A | **Generated.** The 23 imported batches' historical layouts, 383 rows. Regenerate with `npm run finance:manifest -- --write-migration`; verify with `--check`. Layout metadata only, no student data. |

Authentication itself uses Supabase's built-in `auth` schema, which needs no
migration. The foundation migration does add one trigger on `auth.users`
(`on_auth_user_created`) so every sign-up gets a `viewer` profile.

## Applying a migration

The project is now **linked** to the hosted Supabase project
(`supabase/.temp/project-ref`), so pending migrations are applied with the CLI:

```
npx supabase migration list      # local vs remote ledger
npx supabase db push --dry-run   # confirm only the intended files are pending
npx supabase db push             # applies pending migrations only
```

Before a push, confirm the project ref in `.env.local`'s Supabase URL equals
`supabase/.temp/project-ref`. The earlier migrations were applied by hand in the
SQL Editor before linking — see `docs/FINANCE-DATA-01.md` — and the ledger now
records all of them.

Never run `supabase db reset` or `db reset --linked` against the hosted project:
it drops everything.

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
