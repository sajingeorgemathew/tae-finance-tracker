/**
 * Domain types for the finance schema created by
 * `supabase/migrations/20260917143000_finance_foundation.sql`.
 *
 * These are hand-written row shapes: property names and nullability mirror the
 * database columns exactly, so a row can be used without a mapping layer. They
 * are the single source of truth for the app until generated types are wired
 * in — see docs/FINANCE-DATA-01.md ("Generated database types") for the
 * `supabase gen types` command. Generated types are additive: they belong in
 * `src/types/database.ts`, and nothing here should be duplicated into them.
 *
 * Money arrives from PostgREST as a string (NUMERIC is not safely a JS number),
 * so every currency column is typed `string | null` and must be parsed
 * deliberately at the point of calculation. Never coerce it with `+value`
 * without deciding what rounding you want.
 */

/** A UUID primary/foreign key. */
export type UUID = string

/** A calendar day, `YYYY-MM-DD`. Postgres `date`. */
export type ISODate = string

/** An instant, ISO 8601 with offset. Postgres `timestamptz`. */
export type ISODateTime = string

/**
 * A NUMERIC(12,2) column as delivered by PostgREST, e.g. `'1250.00'`.
 * Kept as text so no cents are lost to floating point in transit.
 */
export type MoneyString = string

// -----------------------------------------------------------------------------
// Profiles and roles
// -----------------------------------------------------------------------------

/**
 * Application roles.
 *
 * - `admin` — everything, including program configuration and the audit log
 * - `finance` — read/write operational finance data
 * - `viewer` — read-only
 *
 * New sign-ups are created as `viewer`. The first admin is promoted by hand.
 */
export type AppRole = 'admin' | 'finance' | 'viewer'

export interface Profile {
  id: UUID
  email: string | null
  full_name: string | null
  role: AppRole
  active: boolean
  created_at: ISODateTime
  updated_at: ISODateTime
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/**
 * A program and its receipt/student-number configuration.
 *
 * The number-like fields are strings, not numbers: leading zeroes are
 * significant and must survive a round trip.
 */
export interface Program {
  id: UUID
  name: string
  short_code: string
  /** Stripped from a student number to derive a receipt suffix (125346 -> 346). */
  student_number_prefix: string | null
  /** Second receipt-number component, e.g. `'12500'`. */
  receipt_course_code: string | null
  /** Third receipt-number component, e.g. `'25'`. */
  receipt_course_suffix: string | null
  active: boolean
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface Batch {
  id: UUID
  program_id: UUID
  name: string
  code: string | null
  start_date: ISODate | null
  end_date: ISODate | null
  active: boolean
  /** Worksheet this batch maps to in the legacy workbook. */
  legacy_sheet_name: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

// -----------------------------------------------------------------------------
// People and finance records
// -----------------------------------------------------------------------------

/**
 * A student. Almost everything is nullable because historical records are
 * incomplete, and `student_number` is neither unique nor guaranteed well-formed
 * until import analysis (FINANCE-IMPORT-02) says otherwise.
 */
export interface Student {
  id: UUID
  student_number: string | null
  first_name: string | null
  middle_name: string | null
  last_name: string | null
  display_name: string | null
  /** The name exactly as it appeared in the source workbook. Never rewritten. */
  legacy_name: string | null
  email: string | null
  phone: string | null
  active: boolean
  legacy_source: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type FinanceRecordStatus = 'active' | 'completed' | 'withdrawn' | 'archived'

/**
 * A student's finance record for one program/batch.
 *
 * `legacy_*` fields hold what the workbook said. They are never recalculated,
 * and a computed figure must never be written back over one — the application's
 * own view of the fee lives in `current_total_fee`.
 */
export interface StudentFinanceRecord {
  id: UUID
  student_id: UUID
  program_id: UUID
  batch_id: UUID | null

  legacy_total_fee: MoneyString | null
  legacy_total_paid: MoneyString | null
  legacy_balance: MoneyString | null

  current_total_fee: MoneyString | null

  /** ISO 4217, defaults to `'CAD'`. */
  currency: string
  status: FinanceRecordStatus

  legacy_source_sheet: string | null
  legacy_source_row: number | null

  created_at: ISODateTime
  updated_at: ISODateTime
}

// -----------------------------------------------------------------------------
// Installments
// -----------------------------------------------------------------------------

export type InstallmentType = 'enrollment' | 'monthly' | 'other'

export type InstallmentStatus = 'scheduled' | 'partial' | 'paid' | 'waived' | 'cancelled'

/**
 * A scheduled finance item — not money received.
 *
 * `installment_month` is a date rather than a month index, so a schedule is
 * never limited to twelve items.
 */
export interface Installment {
  id: UUID
  student_finance_record_id: UUID

  sequence_number: number | null

  installment_type: InstallmentType
  /** First day of the month the item belongs to. */
  installment_month: ISODate | null
  due_date: ISODate | null

  scheduled_amount: MoneyString | null

  /** System-generated note. Never overwritten by a staff override. */
  default_note: string | null
  /** Staff override. Resolve with `effectiveNote()`, do not read it directly. */
  custom_note: string | null

  legacy_column_name: string | null
  legacy_value_text: string | null

  status: InstallmentStatus

  created_at: ISODateTime
  updated_at: ISODateTime
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------

export type PaymentSource = 'legacy_import' | 'manual' | 'adjustment'

/**
 * Money actually received.
 *
 * Payments are voided, never deleted. `amount` may be negative for an
 * `adjustment` (refund or correction).
 */
export interface Payment {
  id: UUID
  student_finance_record_id: UUID
  installment_id: UUID | null

  amount: MoneyString
  payment_date: ISODate | null

  payment_method: string | null
  payer_name: string | null
  reference: string | null

  note: string | null

  source: PaymentSource

  legacy_source_sheet: string | null
  legacy_source_row: number | null
  /** The untouched source row, for audit and re-import. */
  legacy_raw_json: unknown | null

  created_by: UUID | null
  created_at: ISODateTime
  updated_at: ISODateTime

  voided_at: ISODateTime | null
  voided_by: UUID | null
  void_reason: string | null
}

// -----------------------------------------------------------------------------
// Receipts
// -----------------------------------------------------------------------------

export type ReceiptStatus = 'draft' | 'generated' | 'sent' | 'void'

/**
 * A receipt.
 *
 * `final_receipt_number` is authoritative and is stored independently of
 * `generated_receipt_number`, because historical receipts carry arbitrary
 * numbers that must never be rewritten.
 *
 * Both are nullable. A `'draft'` receipt exists before a race-condition-safe
 * number has been allocated (FINANCE-RECEIPTS), so consumers must handle null
 * rather than assume a number is present.
 *
 * `status === 'sent'` describes history, not permission: a sent receipt is
 * always eligible for a deliberate resend.
 */
export interface Receipt {
  id: UUID
  payment_id: UUID
  student_finance_record_id: UUID
  installment_id: UUID | null

  /** Per-student counter. Allocation is FINANCE-RECEIPTS work. */
  receipt_sequence: number | null

  program_short_code: string | null
  receipt_course_code: string | null
  receipt_course_suffix: string | null
  /** Student number minus the program prefix, e.g. `'346'`. */
  student_suffix: string | null

  generated_receipt_number: string | null
  /** Null on a draft receipt, until allocation runs. */
  final_receipt_number: string | null

  receipt_number_overridden: boolean
  receipt_number_override_reason: string | null

  amount: MoneyString
  receipt_date: ISODate | null
  payment_method: string | null

  default_note: string | null
  custom_note: string | null

  pdf_storage_path: string | null

  status: ReceiptStatus
  generated_at: ISODateTime | null

  created_by: UUID | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

/**
 * The components of a generated receipt number, in order:
 * `{PROGRAM}-{COURSE_CODE}-{COURSE_SUFFIX}-{STUDENT_SUFFIX}-{SEQUENCE}`
 * e.g. `PSW-12500-25-346-01`.
 *
 * Declared here so the shape is agreed; assembling and allocating a number is
 * FINANCE-RECEIPTS work and is not implemented in this ticket.
 */
export interface ReceiptNumberParts {
  programShortCode: string
  receiptCourseCode: string
  receiptCourseSuffix: string
  studentSuffix: string
  sequence: string
}

// -----------------------------------------------------------------------------
// Deliveries
// -----------------------------------------------------------------------------

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'bounced'

export type ReceiptDeliveryType = 'initial' | 'resend' | 'batch'

/** One send attempt. A receipt may have many. */
export interface ReceiptDelivery {
  id: UUID
  receipt_id: UUID

  recipient_email: string
  delivery_type: ReceiptDeliveryType

  provider: string | null
  provider_message_id: string | null

  status: DeliveryStatus
  sent_at: ISODateTime | null
  failed_at: ISODateTime | null
  /** Short description only. Never a payload or a credential. */
  error_summary: string | null

  sent_by: UUID | null
  created_at: ISODateTime
}

/**
 * Derived send history for a receipt, computed from its deliveries rather than
 * stored on the receipt. Nothing here can make a receipt un-resendable.
 */
export interface ReceiptSendSummary {
  firstSentAt: ISODateTime | null
  lastSentAt: ISODateTime | null
  sendCount: number
}

export interface ReminderDelivery {
  id: UUID
  student_finance_record_id: UUID
  installment_id: UUID | null

  recipient_email: string

  reminder_type: string | null
  /** What was actually sent, captured at send time. */
  subject_snapshot: string | null
  body_snapshot: string | null

  provider: string | null
  provider_message_id: string | null

  status: DeliveryStatus
  sent_at: ISODateTime | null
  failed_at: ISODateTime | null
  error_summary: string | null

  sent_by: UUID | null
  created_at: ISODateTime
}

// -----------------------------------------------------------------------------
// Import and audit
// -----------------------------------------------------------------------------

export type ImportType = 'finance_workbook' | 'students' | 'payments' | 'other'

export type ImportStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back'

export interface ImportBatch {
  id: UUID
  source_filename: string
  source_file_hash: string | null

  import_type: ImportType
  status: ImportStatus

  started_at: ISODateTime
  completed_at: ISODateTime | null

  rows_seen: number | null
  rows_imported: number | null
  rows_skipped: number | null

  notes: string | null

  created_by: UUID | null
  created_at: ISODateTime
}

/**
 * An append-only audit entry. `actor_user_id` is a raw auth user id with no
 * foreign key, so the trail outlives the user who acted.
 */
export interface AuditLogEntry {
  id: UUID
  actor_user_id: UUID | null

  entity_type: string
  entity_id: UUID | null

  action: string

  before_data: unknown | null
  after_data: unknown | null
  metadata: unknown | null

  created_at: ISODateTime
}
