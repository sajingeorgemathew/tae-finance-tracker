-- =============================================================================
-- FINANCE-COLUMN-MANIFEST-03A — batch column manifest (schema)
-- Toronto Academy of Education finance tracker
-- =============================================================================
--
-- Runs after 20260918130000_import_exceptions.sql.
--
-- The historical import kept every populated batch-sheet cell in
-- student_finance_records.legacy_raw_json and omitted blank cells, so that a
-- blank could never be mistaken for a zero. The Finance Grid then rebuilt each
-- batch's columns from the union of cells across its rows — and a column that
-- every student in a batch left empty (a March nobody paid in, a Late Fees
-- nobody incurred, the ELCE roster's Balance) left no trace anywhere and
-- vanished from the screen, though it was plainly there in Excel.
--
-- This table separates COLUMN STRUCTURE from STUDENT VALUES. A row here says
-- "this column existed in this batch, at this position, headed like this, and
-- holds money or text". Whether a given student has a value in it remains the
-- student's record's business. So:
--
--     manifest column exists + no row value  =  blank (em dash)
--                                            ≠  $0.00
--
-- No student row is touched to restore the shape of a table, and nothing here
-- corrects, recalculates or rewrites a historical figure.
--
-- Two origins share the table. `legacy_workbook` rows describe the historical
-- layouts and are inserted by the generated data migration that follows this
-- one. `application` rows are for layouts staff will manage in the application
-- once it replaces the spreadsheet — no such workflow exists yet, but the
-- shape must not preclude one: source_column_letter and the legacy_* fields
-- are nullable, and identity falls back to column_key.
--
-- Additive: one new table, its constraints, indexes, policies and grants. No
-- existing table, column, constraint or row is altered, and no row is written.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------

create table if not exists public.batch_finance_columns (
  id                      uuid primary key default gen_random_uuid(),

  batch_id                uuid        not null references public.batches (id) on delete cascade,

  -- Which group of the grid the column belongs to. `actual` is the historical
  -- ACTUAL FEE STRUCTURE (money as recorded); `installment` is the scheduled
  -- INSTALLMENT FEE STRUCTURE. Constrained, because the grid renders each as a
  -- distinct banner and a third value would render nowhere; widen by migration.
  section                 text        not null
                            check (section in ('actual', 'installment')),

  -- Where the column sat in the source table. Null for application-defined
  -- columns, which have no spreadsheet behind them.
  source_column_letter    text
                            check (source_column_letter is null
                                   or source_column_letter ~ '^[A-Z]{1,3}$'),

  -- The heading exactly as the workbook stores it, trailing spaces and typos
  -- included ("Marc" stays "Marc"). Null when the workbook never headed the
  -- column, in which case the grid names it by its letter. Never rewritten:
  -- normalized_role is where meaning lives, and the two are kept apart.
  source_header           text,
  source_header_inherited boolean     not null default false,

  -- Stable identity of the column within its batch and section, and the key
  -- the grid uses for React and for the per-row cell map. `actual:G` for a
  -- historical column; application-defined columns choose their own.
  column_key              text        not null check (length(trim(column_key)) > 0),

  -- Semantic metadata only. `other` is a legitimate outcome — an unheaded
  -- reconciliation column, an unrecognised heading — and is never resolved to
  -- the nearest plausible meaning.
  normalized_role         text        not null default 'other'
                            check (normalized_role in (
                              'student_number', 'student_name', 'enrollment', 'month',
                              'late_fees', 'total_fee', 'total_paid', 'balance', 'discount',
                              'installment', 'remarks', 'payer', 'other')),

  -- How a cell in this column is read. A REMARKS or Payer column that sits
  -- inside the ACTUAL money span is `text`, so that a value typed into it one
  -- day is never formatted as currency.
  value_kind              text        not null
                            check (value_kind in ('money', 'text')),

  -- Position within the section: source order for historical columns, and
  -- equal to installments.sequence_number for the installment section, which
  -- is how the grid lines normalized installment values up under their column.
  display_order           integer     not null check (display_order > 0),

  -- Whether the main grid shows the column. Text columns are kept for the
  -- detail and editing surfaces of later tickets and hidden from the money
  -- table, so a column of blank remarks cannot read as a fee.
  is_grid_visible         boolean     not null default true,

  -- Whether a column every student leaves blank is still rendered. True for
  -- every historical column: the point of this table is that a blank column
  -- was still a column.
  display_even_if_blank   boolean     not null default true,

  origin                  text        not null default 'legacy_workbook'
                            check (origin in ('legacy_workbook', 'application')),

  -- Provenance for historical rows. Layout metadata only: a worksheet name, a
  -- table key such as title@21, and the workbook's SHA-256. No student data.
  legacy_sheet_name       text,
  legacy_table_key        text,
  source_workbook_hash    text
                            check (source_workbook_hash is null
                                   or source_workbook_hash ~ '^[0-9a-f]{64}$'),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- A historical row must say where it came from; an application row must not
  -- pretend to.
  constraint batch_finance_columns_origin_provenance_check check (
    (origin = 'legacy_workbook'
       and source_column_letter is not null
       and legacy_sheet_name is not null
       and legacy_table_key is not null
       and source_workbook_hash is not null)
    or
    (origin = 'application'
       and source_workbook_hash is null)
  ),

  -- One key per batch and section. Headings may repeat ("Total Fee" appears in
  -- both sections of every PSW table), so the key, not the heading, is unique.
  constraint batch_finance_columns_batch_section_key_key
    unique (batch_id, section, column_key)
);

comment on table public.batch_finance_columns is
  'Column layout of a batch''s finance grid: which columns exist, their order, headings, section, kind and visibility. Structure only — student values live on student_finance_records and installments. A column present here with no row value is blank, never $0.00.';
comment on column public.batch_finance_columns.section is
  'actual (historical ACTUAL FEE STRUCTURE) or installment (scheduled INSTALLMENT FEE STRUCTURE).';
comment on column public.batch_finance_columns.source_column_letter is
  'Spreadsheet column letter in the source table. Null for application-defined columns.';
comment on column public.batch_finance_columns.source_header is
  'The heading exactly as the workbook stores it. Never rewritten; meaning is normalized_role.';
comment on column public.batch_finance_columns.source_header_inherited is
  'True when the source table borrowed this heading from an earlier table on the same sheet.';
comment on column public.batch_finance_columns.column_key is
  'Stable identity of the column within its batch and section; the grid''s cell key.';
comment on column public.batch_finance_columns.normalized_role is
  'Semantic role. Metadata only; ''other'' is legitimate and is never resolved to a guess.';
comment on column public.batch_finance_columns.value_kind is
  'money or text. Decides how a cell is read, independently of which section the column sits in.';
comment on column public.batch_finance_columns.display_order is
  'Position within the section. For installment columns, equals installments.sequence_number.';
comment on column public.batch_finance_columns.is_grid_visible is
  'Whether the main finance grid shows the column. Text columns are kept but hidden.';
comment on column public.batch_finance_columns.display_even_if_blank is
  'Whether the column is rendered when every student in the batch has no value in it.';
comment on column public.batch_finance_columns.origin is
  'legacy_workbook for rows generated from the historical workbook; application for rows staff define later.';
comment on column public.batch_finance_columns.source_workbook_hash is
  'SHA-256 of the workbook a legacy row was generated from. The layout is only valid for that exact file.';


-- -----------------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------------
-- The read path is one query per selected batch, ordered by section and
-- position. The partial unique index is the historical identity rule: one
-- manifest row per batch, section and source column letter, so a regenerated
-- layout cannot double a column. Application rows have no letter and fall
-- back to the (batch_id, section, column_key) uniqueness above.

create index if not exists batch_finance_columns_batch_section_order_idx
  on public.batch_finance_columns (batch_id, section, display_order);

create unique index if not exists batch_finance_columns_source_letter_key
  on public.batch_finance_columns (batch_id, section, source_column_letter)
  where source_column_letter is not null;


-- -----------------------------------------------------------------------------
-- 3. updated_at
-- -----------------------------------------------------------------------------

drop trigger if exists batch_finance_columns_set_updated_at on public.batch_finance_columns;
create trigger batch_finance_columns_set_updated_at before update on public.batch_finance_columns
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. Row Level Security
-- -----------------------------------------------------------------------------
-- Matrix:
--
--   admin    SELECT + INSERT + UPDATE
--   finance  SELECT
--   viewer   SELECT
--   anon     nothing — every policy targets `authenticated`
--
-- Read access matches the rest of the finance schema: anyone who may read the
-- finance grid may read its layout, or the grid cannot be drawn for them.
--
-- Writes are admin-only for now. Changing a batch's column layout changes what
-- every staff member sees for every student in that batch, which is an
-- administrative act rather than day-to-day finance work. The historical rows
-- are inserted by migration, which runs as the database owner and is not
-- subject to these policies. No DELETE policy: a layout row is hidden by
-- flipping is_grid_visible, never removed, so a column that once carried
-- figures keeps its place in the record.

alter table public.batch_finance_columns enable row level security;

drop policy if exists batch_finance_columns_select_read on public.batch_finance_columns;
create policy batch_finance_columns_select_read on public.batch_finance_columns
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists batch_finance_columns_insert_admin on public.batch_finance_columns;
create policy batch_finance_columns_insert_admin on public.batch_finance_columns
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists batch_finance_columns_update_admin on public.batch_finance_columns;
create policy batch_finance_columns_update_admin on public.batch_finance_columns
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
-- As for every finance table: authenticated may read and write and RLS is the
-- gate; nothing grants DELETE, and anon is granted nothing.

grant select, insert, update on public.batch_finance_columns to authenticated;


-- Verify (structure only, never student data):
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'batch_finance_columns'
--   order by ordinal_position;
--
--   select policyname, cmd, roles
--   from pg_policies
--   where schemaname = 'public' and tablename = 'batch_finance_columns'
--   order by policyname;
--
-- Expect three policies (select/insert/update), no delete policy, and
-- rowsecurity = true in pg_tables. The data migration that follows inserts the
-- historical layout; this one inserts nothing.
