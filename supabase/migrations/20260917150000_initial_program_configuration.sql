-- =============================================================================
-- FINANCE-DATA-01 — initial program configuration
-- Toronto Academy of Education finance tracker
-- =============================================================================
--
-- Runs after 20260917143000_finance_foundation.sql.
--
-- This is production configuration, not seed or sample data. The two programs
-- below decide how student numbers are interpreted and how receipt numbers are
-- assembled, so the application is not functional without them. They therefore
-- ship as a migration, applied on every environment by the ordinary migration
-- path, rather than as a seed file somebody has to remember to run by hand.
--
-- Receipt numbers are built as:
--   {PROGRAM}-{COURSE_CODE}-{COURSE_SUFFIX}-{STUDENT_SUFFIX}-{SEQUENCE}
-- where STUDENT_SUFFIX is the student number with student_number_prefix
-- removed: PSW 125346 -> 346, giving PSW-12500-25-346-01.
--
-- Scope: exactly two rows in public.programs. No students, no batches, no
-- finance records, no payments, no receipts — nothing here creates operational
-- data of any kind, and no program other than PSW and ECEA is invented.
-- =============================================================================


-- Conflict target is the named unique constraint created by the foundation
-- migration (`constraint programs_short_code_key unique (short_code)`), not a
-- bare column list: naming it means this statement fails loudly if that
-- constraint is ever renamed or dropped, instead of quietly matching something
-- else. short_code is the stable business key — `id` is a generated uuid and is
-- useless as an identity across environments.
insert into public.programs as p (
  name,
  short_code,
  student_number_prefix,
  receipt_course_code,
  receipt_course_suffix,
  active
)
values
  ('NACC Personal Support Worker',        'PSW',  '125', '12500', '25', true),
  ('Early Childhood Education Assistant', 'ECEA', '121', '12100', '21', true)

on conflict on constraint programs_short_code_key do update
set
  name                  = excluded.name,
  student_number_prefix = excluded.student_number_prefix,
  receipt_course_code   = excluded.receipt_course_code,
  receipt_course_suffix = excluded.receipt_course_suffix

-- `active` is deliberately absent from the SET list. It is set on INSERT (both
-- programs start active) but never forced back to true on a re-run: if an
-- administrator deactivates a program, that is an operational decision and
-- re-applying this file must not silently reverse it. The numbering columns are
-- the opposite case — they are authoritative configuration, and a wrong value
-- there produces wrong receipt numbers on real money, so they are corrected.
--
-- The WHERE clause makes an identical re-run a genuine no-op: no row is
-- rewritten, the programs_set_updated_at trigger does not fire, and updated_at
-- keeps telling the truth about when the configuration last actually changed.
where
  p.name                  is distinct from excluded.name
  or p.student_number_prefix is distinct from excluded.student_number_prefix
  or p.receipt_course_code   is distinct from excluded.receipt_course_code
  or p.receipt_course_suffix is distinct from excluded.receipt_course_suffix;


-- Verify (configuration only, never student data):
--   select short_code, name, student_number_prefix,
--          receipt_course_code, receipt_course_suffix, active, updated_at
--   from public.programs
--   order by short_code;
--
-- Expect exactly:
--   ECEA | Early Childhood Education Assistant | 121 | 12100 | 21 | t
--   PSW  | NACC Personal Support Worker        | 125 | 12500 | 25 | t
