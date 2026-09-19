-- =============================================================================
-- FINANCE-IMPORT-02 — legacy_raw_json on the remaining imported tables
-- Toronto Academy of Education finance tracker
-- =============================================================================
--
-- Runs after 20260917150000_initial_program_configuration.sql.
--
-- The finance foundation gave `payments` a `legacy_raw_json` column so an
-- imported payment could carry the workbook row it came from, verbatim. The
-- import mapping approved for Phase B1 requires the same of three more tables:
--
--   students                 every alternate name spelling seen for one student
--                            number, and the source rows they came from. One
--                            student number is one student, so the spellings
--                            that lost the display-name tie-break have nowhere
--                            else to go, and discarding them would destroy the
--                            evidence a reviewer needs to settle the conflict.
--
--   student_finance_records  the full source row behind the record, including
--                            the batch sheet's ACTUAL-section cells. Those
--                            cells are deliberately NOT imported as payments
--                            (Tracker Master is the payment source, and
--                            importing both would double the money), so this
--                            column is the only place they survive — and it is
--                            what a later legacy-spreadsheet view renders from.
--
--   installments             the source cell behind a scheduled amount, with
--                            its section, so a scheduled figure can never be
--                            confused with the identically-named actual one.
--
-- Additive and nullable throughout: no existing column is altered, no data is
-- rewritten, and nothing here creates, modifies or deletes a row. Applying it
-- to a populated database is a no-op for every existing row.
--
-- This migration is a PREREQUISITE for the import apply (Phase B2). It is not
-- applied by the Phase B1 dry run, which writes nothing.
-- =============================================================================


alter table public.students
  add column if not exists legacy_raw_json jsonb;

comment on column public.students.legacy_raw_json is
  'Source rows behind this student, verbatim, including every alternate name spelling seen for the same student number. Never rewritten; the canonical name lives in legacy_name.';


alter table public.student_finance_records
  add column if not exists legacy_raw_json jsonb;

comment on column public.student_finance_records.legacy_raw_json is
  'The full source row behind this record, verbatim. Holds the batch sheet''s ACTUAL-section cells, which are preserved here rather than imported as payments so the same money is not counted twice.';


alter table public.installments
  add column if not exists legacy_raw_json jsonb;

comment on column public.installments.legacy_raw_json is
  'The source cell behind this scheduled amount, with the section it came from, so a scheduled figure is never confused with the identically-named actual one.';


-- Verify (structure only, never student data):
--   select table_name, column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and column_name = 'legacy_raw_json'
--   order by table_name;
--
-- Expect exactly four rows: installments, payments, student_finance_records,
-- students — all jsonb, all nullable.
