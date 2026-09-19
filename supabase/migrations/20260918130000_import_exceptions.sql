-- =============================================================================
-- FINANCE-IMPORT-02 — import exceptions
-- Toronto Academy of Education finance tracker
-- =============================================================================
--
-- Runs after 20260918120000_legacy_raw_json.sql.
--
-- A source row that cannot safely become a normalized finance record has three
-- possible fates. Two of them are unacceptable: inventing a value so the row
-- fits (a payment of zero the workbook never recorded), or dropping it. This
-- table is the third — the row is preserved, exactly as the workbook holds it,
-- with the reason it could not be normalized.
--
-- The worked example this ships for: one Tracker Master row records a payment
-- with no amount. `payments.amount` is NOT NULL and no zero may be invented, so
-- the row becomes an import_exceptions record instead of a payment. The money
-- is not asserted, and the history is not lost.
--
-- That distinction is what lets a dry run report READY_FOR_APPLY=true honestly:
-- every source row either maps to a normalized entity or is deliberately
-- preserved here, and nothing is silently dropped.
--
-- Additive: creates one new table and its policies. No existing table, column,
-- constraint or row is altered, and nothing here writes a row of any kind.
--
-- This migration is a PREREQUISITE for the import apply (Phase B2). It is not
-- applied by the Phase B1 dry run, which writes nothing.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
-- import_batch_id is nullable so an exception can be recorded by tooling that
-- is not a full import run (a dry run writing a review queue, a later triage
-- pass). When an apply records one it is always set.
--
-- source_key is the importer's deterministic key for the row: workbook hash +
-- where in the workbook it came from. It is what makes a re-run recognise an
-- exception it already recorded instead of duplicating it.

create table if not exists public.import_exceptions (
  id                uuid primary key default gen_random_uuid(),

  import_batch_id   uuid        references public.import_batches (id) on delete set null,

  source_filename   text,
  source_sheet      text,
  source_row        integer,
  source_column     text,

  -- The entity this row would have become: payment, student, installment, …
  entity_type       text,

  reason            text        not null check (length(trim(reason)) > 0),

  source_key        text        not null check (length(trim(source_key)) > 0),

  -- NOT NULL on purpose: an exception with no preserved source data would
  -- record that something was skipped without recording what, which is the
  -- silent drop this table exists to prevent.
  legacy_raw_json   jsonb       not null,

  resolved          boolean     not null default false,
  resolved_at       timestamptz,
  resolved_by       uuid        references public.profiles (id) on delete set null,
  resolution_notes  text,

  created_at        timestamptz not null default now()
);

comment on table public.import_exceptions is
  'Source rows preserved verbatim because they could not safely become normalized finance records. The alternative to inventing a value or dropping the row.';
comment on column public.import_exceptions.import_batch_id is
  'The import run that recorded this. Nullable so triage tooling can record one outside a full run.';
comment on column public.import_exceptions.source_key is
  'The importer''s deterministic key: workbook hash plus where in the workbook the row came from. Lets a re-run recognise an exception it already recorded.';
comment on column public.import_exceptions.legacy_raw_json is
  'The source row, verbatim. NOT NULL: an exception with no preserved data would record that something was skipped without recording what.';
comment on column public.import_exceptions.reason is
  'Why the row could not be normalized, e.g. missing_amount. Free text rather than a check constraint: a new source file may raise a reason nobody has seen, and rejecting it would drop the row this table exists to keep.';
comment on column public.import_exceptions.resolved is
  'Set once a human has dealt with the row. Resolving never deletes it: the historical record of what the workbook held stays.';


-- -----------------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------------
-- The three access paths: everything from one run, everything of one kind, and
-- the idempotency lookup by source key.
--
-- source_key is deliberately NOT unique. One source row can legitimately raise
-- more than one exception — a row may be both unroutable and unamountable —
-- and a unique constraint would make the second one fail the import rather than
-- be recorded. Uniqueness is enforced in the importer, where the rule belongs.

create index if not exists import_exceptions_import_batch_id_idx
  on public.import_exceptions (import_batch_id);

create index if not exists import_exceptions_reason_idx
  on public.import_exceptions (reason);

create index if not exists import_exceptions_source_key_idx
  on public.import_exceptions (source_key);


-- -----------------------------------------------------------------------------
-- 3. Row Level Security
-- -----------------------------------------------------------------------------
-- Matrix, matching the rest of the schema:
--
--   admin    SELECT + INSERT + UPDATE
--   finance  SELECT + INSERT
--   viewer   SELECT
--   anon     nothing — every policy targets `authenticated`
--
-- No DELETE policy: an exception records what the workbook actually contained,
-- so it is resolved (resolved, resolved_by, resolution_notes) rather than
-- removed. Deleting one would destroy the only surviving copy of a source row
-- that was deliberately not normalized.
--
-- UPDATE is admin-only because the only thing worth updating is the resolution,
-- and marking a financial exception "dealt with" is an administrative act.

alter table public.import_exceptions enable row level security;

drop policy if exists import_exceptions_select_read on public.import_exceptions;
create policy import_exceptions_select_read on public.import_exceptions
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists import_exceptions_insert_write on public.import_exceptions;
create policy import_exceptions_insert_write on public.import_exceptions
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists import_exceptions_update_admin on public.import_exceptions;
create policy import_exceptions_update_admin on public.import_exceptions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- Verify (structure only, never student data):
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'import_exceptions'
--   order by ordinal_position;
--
--   select policyname, cmd, roles
--   from pg_policies
--   where schemaname = 'public' and tablename = 'import_exceptions'
--   order by policyname;
--
-- Expect three policies (select/insert/update), no delete policy, and
-- rowsecurity = true in pg_tables.
