-- =============================================================================
-- FINANCE-CUTOVER-05A — generic collection strategy per finance record
-- =============================================================================
-- One nullable column, `student_finance_records.collection_mode`, saying how a
-- finance record is collected. It is generic: the values name a strategy, not
-- a program, so a new program or cohort picks one of them rather than adding a
-- column of its own.
--
--   installment               an installment schedule exists; the amount due is
--                             the schedule through the current calendar month
--                             minus what was paid toward it
--   legacy_balance            the preserved historical balance snapshot is the
--                             basis for collection; the old payment rows are
--                             historical evidence, not a complete ledger
--   balance                   stated fee minus recorded payments; no reliable
--                             installment dates
--   configuration_incomplete  not safe for automated collection until the
--                             program's finance setup is completed
--
-- NULL means "not decided": every existing row stays NULL. The cutover
-- populates the value on its target records; nothing here writes a row.
--
-- Additive only: no existing column, constraint, policy or value changes.
-- Visibility follows the table's existing row-level policies — select under
-- public.can_read_finance(), insert/update under public.can_write_finance() —
-- because the table's grants to `authenticated` are table-level, so the new
-- column needs no grant of its own.
-- =============================================================================

alter table public.student_finance_records
  add column if not exists collection_mode text;

alter table public.student_finance_records
  drop constraint if exists student_finance_records_collection_mode_check;

alter table public.student_finance_records
  add constraint student_finance_records_collection_mode_check
    check (collection_mode is null or collection_mode in (
      'installment', 'legacy_balance', 'balance', 'configuration_incomplete'));

comment on column public.student_finance_records.collection_mode is
  'Generic collection strategy: installment, legacy_balance, balance or configuration_incomplete. NULL = not decided. Never program-specific.';
