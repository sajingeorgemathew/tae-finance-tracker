# types

Shared TypeScript types.

- `finance.ts` — hand-written row shapes for every table in the finance
  foundation migration, plus the role, status and note unions the app uses.
  This is the source of truth today.
- `database.ts` — *not present yet*. Reserved for types generated from the live
  schema (`supabase gen types typescript`). See `docs/FINANCE-DATA-01.md`;
  generating them is optional and must not overwrite `finance.ts`.

Money columns are `NUMERIC(12,2)` and arrive from PostgREST as **strings**.
They are typed `MoneyString`, never `number`, so cents are not lost in transit.
Parse deliberately at the point of calculation.
