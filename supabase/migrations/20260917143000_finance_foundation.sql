-- =============================================================================
-- FINANCE-DATA-01 — finance foundation schema
-- Toronto Academy of Education finance tracker
-- =============================================================================
--
-- Creates programs, batches, students, finance records, installments, payments,
-- receipts, delivery history, import audit and the audit log, plus profiles /
-- roles and Row Level Security for all of them.
--
-- Deliberately NOT in this migration (see docs/FINANCE-DATA-01.md):
--   * receipt-number allocation (sequence/race handling) -> FINANCE-RECEIPTS
--   * workbook import                                    -> FINANCE-IMPORT-02
--   * all data of every kind. Program configuration is production
--     configuration and ships as its own migration,
--     20260917150000_initial_program_configuration.sql
--
-- Idempotency: objects use IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF
-- EXISTS so the file can be re-run during development. Note that
-- CREATE TABLE IF NOT EXISTS does not reconcile an existing table: column and
-- constraint changes after first application need their own migration.
--
-- Money is NUMERIC(12,2) everywhere. No floating point.
-- Instants are timestamptz; calendar days are date.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Shared helpers
-- -----------------------------------------------------------------------------

-- Keeps updated_at honest without every caller remembering to set it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with now().';


-- -----------------------------------------------------------------------------
-- 2. Profiles and roles
-- -----------------------------------------------------------------------------
-- One row per auth user. Role drives every RLS policy in this migration.
--
--   admin   — full read/write, including program configuration and audit log
--   finance — read/write of operational finance data
--   viewer  — read-only
--
-- New sign-ups get 'viewer'. The first admin is promoted by hand; see
-- docs/FINANCE-DATA-01.md ("Bootstrapping the first admin").

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        text        not null default 'viewer'
                          check (role in ('admin', 'finance', 'viewer')),
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile and role for each auth.users row. Role changes are admin-only.';
comment on column public.profiles.active is
  'Deactivated profiles keep their history but lose all finance access.';

-- Creates the profile row for a new sign-up. Never grants admin.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT ON auth.users: creates a viewer profile. Never assigns admin.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- Role helpers.
--
-- SECURITY DEFINER precautions (only current_app_role() needs the elevation):
--   * `set search_path = ''` on every function, so no object is ever resolved
--     through a caller-controlled search_path.
--   * every reference is schema-qualified (public.profiles, auth.uid()).
--   * no dynamic SQL anywhere, so there is nothing to inject into.
--   * the lookup is pinned to `p.id = auth.uid()`. The caller supplies no
--     argument, so the role that comes back is always the caller's own, and a
--     user cannot ask about — or substitute — anyone else's row.
--   * `and p.active` means a deactivated profile resolves to NULL and therefore
--     to false in every helper below: no finance access at all.
--   * an anonymous caller has auth.uid() = NULL, matches no profile row, and
--     resolves to NULL for the same reason.
--   * EXECUTE is revoked from PUBLIC and anon and granted only to
--     authenticated; see section 17.
--
-- is_admin() / can_write_finance() / can_read_finance() are deliberately NOT
-- SECURITY DEFINER. They are plain STABLE wrappers, so the elevation stays
-- confined to the single function that genuinely needs it.

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid())
    and p.active
$$;

comment on function public.current_app_role() is
  'Role of the calling user, or NULL when unauthenticated / deactivated.';

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

create or replace function public.can_write_finance()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('admin', 'finance'), false)
$$;

create or replace function public.can_read_finance()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('admin', 'finance', 'viewer'), false)
$$;


-- Defence in depth against privilege escalation.
--
-- RLS already prevents it: profiles has no self-update policy, so a finance or
-- viewer session matches nothing on UPDATE. This trigger makes that structural
-- rather than incidental — if a permissive self-service policy is ever added by
-- mistake, `role` and `active` still cannot be changed by the user they belong
-- to. It blocks self-promotion to admin or finance, and blocks a user whom an
-- admin deactivated from turning `active` back on.
--
-- auth.uid() IS NULL is allowed through on purpose: that is the service_role /
-- SQL-editor path, which is how the first admin is bootstrapped and how future
-- server-side administration will run. It is not reachable from a browser
-- session using the publishable key.
--
-- Plain SECURITY INVOKER: it reads only OLD/NEW and the role helpers, so it
-- needs no elevation of its own.
create or replace function public.guard_profile_privilege_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    return new;                       -- service_role / SQL editor
  end if;

  if new.role is distinct from old.role
     or new.active is distinct from old.active
  then
    if not public.is_admin() or caller = old.id then
      raise exception
        'profiles.role and profiles.active may only be changed by an administrator, and never on your own account'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_privilege_change() is
  'BEFORE UPDATE on profiles: blocks self-service role/active changes even if an RLS policy would allow the row through.';

drop trigger if exists profiles_guard_privilege_change on public.profiles;
create trigger profiles_guard_privilege_change
  before update on public.profiles
  for each row execute function public.guard_profile_privilege_change();


-- -----------------------------------------------------------------------------
-- 3. Programs (configuration)
-- -----------------------------------------------------------------------------
-- Number-like identifiers are TEXT on purpose: leading zeroes are meaningful in
-- receipt numbers and student numbers, and would be lost by an integer type.

create table if not exists public.programs (
  id                     uuid primary key default gen_random_uuid(),
  name                   text        not null check (length(trim(name)) > 0),
  short_code             text        not null check (length(trim(short_code)) > 0),
  student_number_prefix  text,
  receipt_course_code    text,
  receipt_course_suffix  text,
  active                 boolean     not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint programs_short_code_key unique (short_code)
);

comment on table public.programs is
  'Program configuration. Drives student-number prefixes and receipt-number components.';
comment on column public.programs.student_number_prefix is
  'TEXT. Stripped from a student number to derive the receipt student suffix (125346 -> 346).';
comment on column public.programs.receipt_course_code is
  'TEXT. Second component of a generated receipt number, e.g. 12500.';
comment on column public.programs.receipt_course_suffix is
  'TEXT. Third component of a generated receipt number, e.g. 25.';


-- -----------------------------------------------------------------------------
-- 4. Batches
-- -----------------------------------------------------------------------------

create table if not exists public.batches (
  id                 uuid primary key default gen_random_uuid(),
  program_id         uuid        not null references public.programs (id) on delete restrict,
  name               text        not null check (length(trim(name)) > 0),
  code               text,
  start_date         date,
  end_date           date,
  active             boolean     not null default true,
  legacy_sheet_name  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint batches_program_name_key unique (program_id, name),
  constraint batches_date_order_check
    check (start_date is null or end_date is null or end_date >= start_date)
);

comment on table public.batches is
  'A cohort within a program.';
comment on column public.batches.legacy_sheet_name is
  'Worksheet this batch corresponds to in the legacy workbook. Lets FINANCE-IMPORT-02 map sheets to batches.';


-- -----------------------------------------------------------------------------
-- 5. Students
-- -----------------------------------------------------------------------------
-- Names and email are deliberately nullable, and student_number has no unique
-- constraint: historical records are incomplete and may repeat or malform a
-- student number. Uniqueness is revisited after import analysis
-- (FINANCE-IMPORT-02) so nothing here can reject a historical row.

create table if not exists public.students (
  id              uuid primary key default gen_random_uuid(),
  student_number  text,
  first_name      text,
  middle_name     text,
  last_name       text,
  display_name    text,
  legacy_name     text,
  email           text,
  phone           text,
  active          boolean     not null default true,
  legacy_source   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.students is
  'A person. No uniqueness enforced on student_number yet — see FINANCE-IMPORT-02.';
comment on column public.students.display_name is
  'Preferred display form, when the parsed name parts are not the right label.';
comment on column public.students.legacy_name is
  'Name exactly as it appeared in the source workbook. Never rewritten.';
comment on column public.students.legacy_source is
  'Where this row came from, e.g. a workbook sheet name. NULL for records created in the app.';


-- -----------------------------------------------------------------------------
-- 6. Student finance records
-- -----------------------------------------------------------------------------
-- A student's finance/enrolment record for one program (and usually one batch).
--
-- legacy_* columns preserve the imported source values verbatim. They are never
-- recomputed, and calculated figures must never be written back over them. The
-- separation is the whole point: current_total_fee is what the application
-- believes, legacy_total_fee is what the workbook said.

create table if not exists public.student_finance_records (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid        not null references public.students (id) on delete restrict,
  program_id          uuid        not null references public.programs (id) on delete restrict,
  batch_id            uuid        references public.batches (id) on delete set null,

  legacy_total_fee    numeric(12,2),
  legacy_total_paid   numeric(12,2),
  legacy_balance      numeric(12,2),

  current_total_fee   numeric(12,2),

  currency            text        not null default 'CAD'
                                  check (currency ~ '^[A-Z]{3}$'),

  status              text        not null default 'active'
                                  check (status in ('active', 'completed', 'withdrawn', 'archived')),

  legacy_source_sheet text,
  legacy_source_row   integer,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.student_finance_records is
  'A single student finance record for one program/batch.';
comment on column public.student_finance_records.legacy_balance is
  'Balance as stated by the source workbook. Preserved as-is even when it disagrees with the payments on file.';
comment on column public.student_finance_records.current_total_fee is
  'Fee the application maintains. Independent of legacy_total_fee by design.';


-- -----------------------------------------------------------------------------
-- 7. Installments (scheduled items)
-- -----------------------------------------------------------------------------
-- Scheduled finance items, not confirmed money. installment_month is a date, so
-- nothing here assumes a twelve-month schedule or a fixed set of month names.
--
-- Effective note = custom_note ?? default_note, computed in application logic.
-- default_note is never overwritten when staff supply a custom note.

create table if not exists public.installments (
  id                        uuid primary key default gen_random_uuid(),
  student_finance_record_id uuid        not null
                              references public.student_finance_records (id) on delete cascade,

  sequence_number           integer,

  installment_type          text        not null
                              check (installment_type in ('enrollment', 'monthly', 'other')),

  installment_month         date,
  due_date                  date,

  scheduled_amount          numeric(12,2),

  default_note              text,
  custom_note               text,

  legacy_column_name        text,
  legacy_value_text         text,

  status                    text        not null default 'scheduled'
                              check (status in ('scheduled', 'partial', 'paid', 'waived', 'cancelled')),

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table public.installments is
  'Scheduled finance items. A scheduled item is not a payment.';
comment on column public.installments.installment_month is
  'First day of the month an item belongs to. A date, not a month number, so no twelve-month assumption is baked in.';
comment on column public.installments.default_note is
  'System-generated note, e.g. "Enrolment fee" or "September installment". Never overwritten by a custom note.';
comment on column public.installments.custom_note is
  'Staff override. Effective note is custom_note ?? default_note, resolved in application code.';
comment on column public.installments.legacy_value_text is
  'Raw cell text from the source workbook, kept verbatim for audit.';


-- -----------------------------------------------------------------------------
-- 8. Payments
-- -----------------------------------------------------------------------------
-- Normal payments are never hard-deleted through the application: there is no
-- DELETE policy on this table, so a mistaken payment is voided (voided_at,
-- voided_by, void_reason) rather than removed. Void UI arrives in a later
-- ticket; the columns exist now so history is never lost.
--
-- amount is intentionally unconstrained in sign: an 'adjustment' may be
-- negative (refund, correction).

create table if not exists public.payments (
  id                        uuid primary key default gen_random_uuid(),
  student_finance_record_id uuid        not null
                              references public.student_finance_records (id) on delete restrict,
  installment_id            uuid        references public.installments (id) on delete set null,

  amount                    numeric(12,2) not null,
  payment_date              date,

  payment_method            text,
  payer_name                text,
  reference                 text,

  note                      text,

  source                    text        not null
                              check (source in ('legacy_import', 'manual', 'adjustment')),

  legacy_source_sheet       text,
  legacy_source_row         integer,
  legacy_raw_json           jsonb,

  created_by                uuid        references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  voided_at                 timestamptz,
  voided_by                 uuid        references public.profiles (id) on delete set null,
  void_reason               text,

  constraint payments_void_consistency_check
    check (
      (voided_at is null and voided_by is null and void_reason is null)
      or voided_at is not null
    )
);

comment on table public.payments is
  'Money actually received. Voided, never deleted, through application workflows.';
comment on column public.payments.legacy_raw_json is
  'Untouched source row from the workbook, for audit and re-import.';
comment on column public.payments.source is
  'legacy_import = came from the workbook; manual = keyed in the app; adjustment = correction/refund.';
comment on column public.payments.voided_at is
  'Set when a payment is voided. A voided payment stays on file with its reason.';


-- -----------------------------------------------------------------------------
-- 9. Receipts
-- -----------------------------------------------------------------------------
-- final_receipt_number is the authoritative number and is stored independently
-- of generated_receipt_number. Historical receipts carry arbitrary numbers that
-- must never be rewritten; generated_receipt_number records what the (future)
-- numbering engine produced.
--
-- New numbering will eventually be:
--   {PROGRAM}-{COURSE_CODE}-{COURSE_SUFFIX}-{STUDENT_SUFFIX}-{SEQUENCE}
--   e.g. PSW-12500-25-346-01
-- Allocation is NOT implemented here: it needs transactional sequence handling
-- and belongs to FINANCE-RECEIPTS.
--
-- No unique constraint on final_receipt_number or payment_id: legacy data may
-- repeat either. The one-receipt-per-payment rule is enforced in application
-- logic until import analysis proves a database constraint is safe.
--
-- Both number columns are nullable: a draft receipt exists before allocation,
-- and historical imports must preserve whatever value they already have.
-- Requiring a number on a non-draft receipt is application-level for now; it is
-- not a CHECK here because the import of legacy rows has not been analysed yet.

create table if not exists public.receipts (
  id                             uuid primary key default gen_random_uuid(),
  payment_id                     uuid        not null
                                   references public.payments (id) on delete restrict,
  student_finance_record_id      uuid        not null
                                   references public.student_finance_records (id) on delete restrict,
  installment_id                 uuid        references public.installments (id) on delete set null,

  receipt_sequence               integer,

  program_short_code             text,
  receipt_course_code            text,
  receipt_course_suffix          text,
  student_suffix                 text,

  -- Both numbers are NULLABLE. A receipt exists in 'draft' before a
  -- race-condition-safe number is allocated (FINANCE-RECEIPTS), and historical
  -- imports must be able to carry arbitrary pre-existing values. The CHECK
  -- rejects an empty or whitespace-only string but allows NULL.
  generated_receipt_number       text
                                   check (generated_receipt_number is null
                                          or length(trim(generated_receipt_number)) > 0),
  final_receipt_number           text
                                   check (final_receipt_number is null
                                          or length(trim(final_receipt_number)) > 0),

  receipt_number_overridden      boolean     not null default false,
  receipt_number_override_reason text,

  amount                         numeric(12,2) not null,
  receipt_date                   date,
  payment_method                 text,

  default_note                   text,
  custom_note                    text,

  pdf_storage_path               text,

  status                         text        not null default 'draft'
                                   check (status in ('draft', 'generated', 'sent', 'void')),

  generated_at                   timestamptz,

  created_by                     uuid        references public.profiles (id) on delete set null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

comment on table public.receipts is
  'One receipt. Status "sent" never blocks a resend — see receipt_deliveries.';
comment on column public.receipts.final_receipt_number is
  'Authoritative number, including arbitrary historical values. NULL until allocated on a draft. Never rewritten by the application.';
comment on column public.receipts.generated_receipt_number is
  'What the numbering engine produced, kept separately from the authoritative number. NULL until allocation runs.';
comment on column public.receipts.student_suffix is
  'Student number with the program prefix removed, e.g. 125346 -> 346.';
comment on column public.receipts.receipt_sequence is
  'Per-student receipt counter. Allocation is deferred to FINANCE-RECEIPTS.';


-- -----------------------------------------------------------------------------
-- 10. Receipt deliveries
-- -----------------------------------------------------------------------------
-- Append-only send history. One receipt may be sent any number of times, so
-- "first sent", "last sent" and "send count" are derived from these rows rather
-- than from a flag on the receipt. There is deliberately no can_send boolean:
-- a sent receipt is always eligible for a deliberate resend.
--
-- Never store provider API secrets here. provider_message_id only.

create table if not exists public.receipt_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  receipt_id          uuid        not null references public.receipts (id) on delete cascade,

  recipient_email     text        not null check (length(trim(recipient_email)) > 0),

  delivery_type       text        not null default 'initial'
                        check (delivery_type in ('initial', 'resend', 'batch')),

  provider            text,
  provider_message_id text,

  status              text        not null default 'queued'
                        check (status in ('queued', 'sent', 'failed', 'bounced')),
  sent_at             timestamptz,
  failed_at           timestamptz,
  error_summary       text,

  sent_by             uuid        references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now()
);

comment on table public.receipt_deliveries is
  'Delivery attempts for a receipt. Source of first sent / last sent / send count.';
comment on column public.receipt_deliveries.error_summary is
  'Short provider error description. Never a payload or a credential.';


-- -----------------------------------------------------------------------------
-- 11. Reminder deliveries
-- -----------------------------------------------------------------------------

create table if not exists public.reminder_deliveries (
  id                        uuid primary key default gen_random_uuid(),
  student_finance_record_id uuid        not null
                              references public.student_finance_records (id) on delete cascade,
  installment_id            uuid        references public.installments (id) on delete set null,

  recipient_email           text        not null check (length(trim(recipient_email)) > 0),

  reminder_type             text,
  subject_snapshot          text,
  body_snapshot             text,

  provider                  text,
  provider_message_id       text,

  status                    text        not null default 'queued'
                              check (status in ('queued', 'sent', 'failed', 'bounced')),
  sent_at                   timestamptz,
  failed_at                 timestamptz,
  error_summary             text,

  sent_by                   uuid        references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now()
);

comment on table public.reminder_deliveries is
  'Payment reminder send history, individual or batch. Snapshots record what was actually sent.';


-- -----------------------------------------------------------------------------
-- 12. Import batches
-- -----------------------------------------------------------------------------

create table if not exists public.import_batches (
  id                uuid primary key default gen_random_uuid(),
  source_filename   text        not null,
  source_file_hash  text,

  import_type       text        not null
                      check (import_type in ('finance_workbook', 'students', 'payments', 'other')),
  status            text        not null default 'pending'
                      check (status in ('pending', 'running', 'completed', 'failed', 'rolled_back')),

  started_at        timestamptz not null default now(),
  completed_at      timestamptz,

  rows_seen         integer,
  rows_imported     integer,
  rows_skipped      integer,

  notes             text,

  created_by        uuid        references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now()
);

comment on table public.import_batches is
  'One run of an import. Makes FINANCE-IMPORT-02 auditable and repeatable.';
comment on column public.import_batches.source_file_hash is
  'Content hash of the source file, so a re-import of the same workbook is recognisable.';


-- -----------------------------------------------------------------------------
-- 13. Audit log
-- -----------------------------------------------------------------------------
-- Schema only. No universal trigger system: blanket triggers over financial
-- tables are easy to get subtly wrong, so entries are written by explicit
-- application-level helpers in a later ticket.
--
-- actor_user_id has no foreign key on purpose — the trail must survive the
-- deletion of the user who acted.

create table if not exists public.audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid,

  entity_type   text        not null,
  entity_id     uuid,

  action        text        not null,

  before_data   jsonb,
  after_data    jsonb,

  metadata      jsonb,

  created_at    timestamptz not null default now()
);

comment on table public.audit_log is
  'Append-only record of sensitive finance changes. Admin reads; admin and finance insert. No UPDATE or DELETE policy exists.';
comment on column public.audit_log.actor_user_id is
  'Raw auth user id, intentionally without a foreign key so the trail outlives the user. RLS forces it to equal auth.uid() for any authenticated insert.';


-- -----------------------------------------------------------------------------
-- 14. updated_at triggers
-- -----------------------------------------------------------------------------
-- Delivery, import and audit rows are append-only / stamped with their own
-- event timestamps, so they carry created_at only.

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists programs_set_updated_at on public.programs;
create trigger programs_set_updated_at before update on public.programs
  for each row execute function public.set_updated_at();

drop trigger if exists batches_set_updated_at on public.batches;
create trigger batches_set_updated_at before update on public.batches
  for each row execute function public.set_updated_at();

drop trigger if exists students_set_updated_at on public.students;
create trigger students_set_updated_at before update on public.students
  for each row execute function public.set_updated_at();

drop trigger if exists student_finance_records_set_updated_at on public.student_finance_records;
create trigger student_finance_records_set_updated_at before update on public.student_finance_records
  for each row execute function public.set_updated_at();

drop trigger if exists installments_set_updated_at on public.installments;
create trigger installments_set_updated_at before update on public.installments
  for each row execute function public.set_updated_at();

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
  for each row execute function public.set_updated_at();

drop trigger if exists receipts_set_updated_at on public.receipts;
create trigger receipts_set_updated_at before update on public.receipts
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- 15. Indexes
-- -----------------------------------------------------------------------------
-- Foreign keys used for lookup, plus the columns the app searches on. Nothing
-- speculative — more can be added once real query patterns exist.

create index if not exists students_student_number_idx on public.students (student_number);
create index if not exists students_email_lower_idx    on public.students (lower(email));

create index if not exists batches_program_id_idx on public.batches (program_id);

create index if not exists student_finance_records_student_id_idx on public.student_finance_records (student_id);
create index if not exists student_finance_records_batch_id_idx   on public.student_finance_records (batch_id);
create index if not exists student_finance_records_program_id_idx on public.student_finance_records (program_id);

create index if not exists installments_finance_record_id_idx on public.installments (student_finance_record_id);
create index if not exists installments_due_date_idx         on public.installments (due_date);

create index if not exists payments_finance_record_id_idx on public.payments (student_finance_record_id);
create index if not exists payments_installment_id_idx    on public.payments (installment_id);
create index if not exists payments_payment_date_idx      on public.payments (payment_date);

create index if not exists receipts_finance_record_id_idx    on public.receipts (student_finance_record_id);
create index if not exists receipts_payment_id_idx           on public.receipts (payment_id);
create index if not exists receipts_final_receipt_number_idx on public.receipts (final_receipt_number);

create index if not exists receipt_deliveries_receipt_id_idx on public.receipt_deliveries (receipt_id);

create index if not exists reminder_deliveries_finance_record_id_idx
  on public.reminder_deliveries (student_finance_record_id);

create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id, created_at desc);


-- -----------------------------------------------------------------------------
-- 16. Row Level Security
-- -----------------------------------------------------------------------------
-- Every application table has RLS enabled and every policy targets the
-- `authenticated` role, so an anonymous caller (the publishable key without a
-- session) matches no policy and sees nothing.
--
-- Write matrix:
--
--   table                    select              insert/update      delete
--   ------------------------ ------------------- ------------------ -------
--   programs                 read finance        admin              none
--   batches                  read finance        write finance      none
--   students                 read finance        write finance      none
--   student_finance_records  read finance        write finance      none
--   installments             read finance        write finance      none
--   payments                 read finance        write finance      none  (void, never delete)
--   receipts                 read finance        write finance      none
--   receipt_deliveries       read finance        write finance      none
--   reminder_deliveries      read finance        write finance      none
--   import_batches           read finance        write finance      none
--   audit_log                admin only          insert, actor=self none  (append-only)
--   profiles                 self or admin       admin              none  (role/active also trigger-guarded)
--
-- where read finance  = admin | finance | viewer  (public.can_read_finance())
--       write finance = admin | finance          (public.can_write_finance())
--
-- No table grants DELETE to anybody. Financial history is corrected by voiding
-- or by a deliberate, audited SQL intervention — never by application code.

alter table public.profiles                enable row level security;
alter table public.programs                enable row level security;
alter table public.batches                 enable row level security;
alter table public.students                enable row level security;
alter table public.student_finance_records enable row level security;
alter table public.installments            enable row level security;
alter table public.payments                enable row level security;
alter table public.receipts                enable row level security;
alter table public.receipt_deliveries      enable row level security;
alter table public.reminder_deliveries     enable row level security;
alter table public.import_batches          enable row level security;
alter table public.audit_log               enable row level security;


-- profiles ---------------------------------------------------------------
-- A user may read their own profile (including when deactivated, so the app can
-- say why access is gone). Only an admin may read anyone else's, or write any
-- profile at all.
--
-- There is deliberately no self-update policy. A normal authenticated user
-- therefore cannot change their own role, promote themselves to admin or
-- finance, reactivate themselves after an admin set active = false, or touch
-- anyone else's profile: every one of those is an UPDATE, and UPDATE matches
-- only profiles_update_admin. public.guard_profile_privilege_change() enforces
-- the same rule a second time at trigger level.
--
-- Admin role management stays possible: an admin passes is_admin() and may
-- update any profile other than their own.

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin());

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- programs ---------------------------------------------------------------
-- Program configuration decides receipt-number components, so it is
-- admin-write. Finance and viewer read it.

drop policy if exists programs_select_read on public.programs;
create policy programs_select_read on public.programs
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists programs_insert_admin on public.programs;
create policy programs_insert_admin on public.programs
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists programs_update_admin on public.programs;
create policy programs_update_admin on public.programs
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- batches ----------------------------------------------------------------

drop policy if exists batches_select_read on public.batches;
create policy batches_select_read on public.batches
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists batches_insert_write on public.batches;
create policy batches_insert_write on public.batches
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists batches_update_write on public.batches;
create policy batches_update_write on public.batches
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- students ---------------------------------------------------------------

drop policy if exists students_select_read on public.students;
create policy students_select_read on public.students
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists students_insert_write on public.students;
create policy students_insert_write on public.students
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists students_update_write on public.students;
create policy students_update_write on public.students
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- student_finance_records ------------------------------------------------

drop policy if exists student_finance_records_select_read on public.student_finance_records;
create policy student_finance_records_select_read on public.student_finance_records
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists student_finance_records_insert_write on public.student_finance_records;
create policy student_finance_records_insert_write on public.student_finance_records
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists student_finance_records_update_write on public.student_finance_records;
create policy student_finance_records_update_write on public.student_finance_records
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- installments -----------------------------------------------------------

drop policy if exists installments_select_read on public.installments;
create policy installments_select_read on public.installments
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists installments_insert_write on public.installments;
create policy installments_insert_write on public.installments
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists installments_update_write on public.installments;
create policy installments_update_write on public.installments
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- payments ---------------------------------------------------------------
-- Update is allowed so a payment can be voided and annotated. No delete.

drop policy if exists payments_select_read on public.payments;
create policy payments_select_read on public.payments
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists payments_insert_write on public.payments;
create policy payments_insert_write on public.payments
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists payments_update_write on public.payments;
create policy payments_update_write on public.payments
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- receipts ---------------------------------------------------------------

drop policy if exists receipts_select_read on public.receipts;
create policy receipts_select_read on public.receipts
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists receipts_insert_write on public.receipts;
create policy receipts_insert_write on public.receipts
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists receipts_update_write on public.receipts;
create policy receipts_update_write on public.receipts
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- receipt_deliveries -----------------------------------------------------
-- Insert covers every send, including a resend. Update exists so a queued row
-- can be resolved to sent/failed by the send worker.

drop policy if exists receipt_deliveries_select_read on public.receipt_deliveries;
create policy receipt_deliveries_select_read on public.receipt_deliveries
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists receipt_deliveries_insert_write on public.receipt_deliveries;
create policy receipt_deliveries_insert_write on public.receipt_deliveries
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists receipt_deliveries_update_write on public.receipt_deliveries;
create policy receipt_deliveries_update_write on public.receipt_deliveries
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- reminder_deliveries ----------------------------------------------------

drop policy if exists reminder_deliveries_select_read on public.reminder_deliveries;
create policy reminder_deliveries_select_read on public.reminder_deliveries
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists reminder_deliveries_insert_write on public.reminder_deliveries;
create policy reminder_deliveries_insert_write on public.reminder_deliveries
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists reminder_deliveries_update_write on public.reminder_deliveries;
create policy reminder_deliveries_update_write on public.reminder_deliveries
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- import_batches ---------------------------------------------------------

drop policy if exists import_batches_select_read on public.import_batches;
create policy import_batches_select_read on public.import_batches
  for select to authenticated
  using (public.can_read_finance());

drop policy if exists import_batches_insert_write on public.import_batches;
create policy import_batches_insert_write on public.import_batches
  for insert to authenticated
  with check (public.can_write_finance());

drop policy if exists import_batches_update_write on public.import_batches;
create policy import_batches_update_write on public.import_batches
  for update to authenticated
  using (public.can_write_finance())
  with check (public.can_write_finance());


-- audit_log --------------------------------------------------------------
-- Append-only, and deliberately asymmetric:
--
--   admin   SELECT + INSERT
--   finance INSERT only, attributed to themselves — no SELECT yet
--   viewer  nothing (fails both can_write_finance() and is_admin())
--   anon    nothing (both policies are `to authenticated`)
--
-- There is no UPDATE and no DELETE policy, so no authenticated session can
-- rewrite or erase the trail through PostgREST at all.
--
-- actor_user_id must equal auth.uid() exactly. NULL is rejected as well: an
-- authenticated session may not write an unattributed entry, because an
-- unattributed entry is indistinguishable from a forged one. Writing on behalf
-- of another actor is therefore only possible through service_role, which
-- bypasses RLS — that is the "deliberately secured server mechanism" a later
-- ticket will build on, and it is never reachable from the browser.

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin on public.audit_log
  for select to authenticated
  using (public.is_admin());

drop policy if exists audit_log_insert_write on public.audit_log;
create policy audit_log_insert_write on public.audit_log
  for insert to authenticated
  with check (
    public.can_write_finance()
    and actor_user_id = (select auth.uid())
  );


-- -----------------------------------------------------------------------------
-- 17. Grants
-- -----------------------------------------------------------------------------
-- Hosted Supabase already grants table privileges to anon/authenticated by
-- default, and RLS is the real gate. These statements are written out anyway so
-- the intent survives a restore into an environment without those defaults:
-- authenticated may read and write, nothing grants DELETE, and anon is granted
-- nothing here.
--
-- Functions need the opposite treatment. Postgres grants EXECUTE on a new
-- function to PUBLIC automatically, which would hand anon (and any other role)
-- the right to call the SECURITY DEFINER role lookup. Calling it as anon only
-- ever returns NULL, so it leaks nothing — but an unnecessary grant on a
-- definer function is exactly the thing that becomes a hole later, so it is
-- revoked here and re-granted only where it is needed.

grant select, insert, update on
  public.programs,
  public.batches,
  public.students,
  public.student_finance_records,
  public.installments,
  public.payments,
  public.receipts,
  public.receipt_deliveries,
  public.reminder_deliveries,
  public.import_batches,
  public.profiles
to authenticated;

grant select, insert on public.audit_log to authenticated;

-- Trigger functions: nobody calls these directly. Postgres checks EXECUTE when
-- the trigger is created, not when it fires, so revoking here does not affect
-- the triggers wired up in sections 2 and 14.
revoke all on function
  public.set_updated_at(),
  public.handle_new_user(),
  public.guard_profile_privilege_change()
from public, anon, authenticated;

-- Role helpers: RLS policies evaluate these as the calling role, so
-- `authenticated` genuinely needs EXECUTE. anon never does.
revoke all on function
  public.current_app_role(),
  public.is_admin(),
  public.can_write_finance(),
  public.can_read_finance()
from public, anon;

grant execute on function
  public.current_app_role(),
  public.is_admin(),
  public.can_write_finance(),
  public.can_read_finance()
to authenticated;
