# Student data sync (FINANCE-STUDENT-SYNC-05B)

CURRENT STUDENT FILE → MATCH AGAINST LIVE FINANCE STUDENTS → SHOW DIFFERENCES → REVIEW → SAFE APPLY

This ticket covers everything up to and including the review. The apply is designed (below) but not enabled.

## Run

```
npm run finance:student-sync -- --export-template          # .private/finance-student-sync/current-students-template.csv, pre-filled with the live students
npm run finance:student-sync                               # the ONE .csv/.xlsx in reference/current-students/ (Git-ignored)
npm run finance:student-sync -- --source=<file> [--sheet=<name>] [--scope=psw-live-2026] [--cross-check-master]
```

Output (Git-ignored, PII): `.private/finance-student-sync/student-sync-preview.csv` (one row per incoming row and per unmatched live student),
`student-sync-summary.md` (counts only), `student-sync-plan.json` (the hashed plan).

## Input

A `.csv` or `.xlsx` with one header row, which must be within the first 20 rows, and one student per row. Headings are matched case- and punctuation-insensitively:

| Field | Required | Accepted headings (examples) |
| --- | --- | --- |
| Student Number | yes | Student Number, Student No, Student ID |
| Name | yes | Student Name, Name, Full Name — or First / Middle / Last Name |
| Email | no | Email, Email Address, E-mail |
| Phone | no | Phone, Mobile, Cell, Contact Number |
| Batch / Intake | recommended | Batch / Intake, Intake, Cohort, Batch — e.g. `June 2026`, `1st June 2026`, `2026-06-01` |
| Session | recommended | Session, Shift — `Morning` / `Evening` (also read from the batch text) |

Other columns are ignored and listed. Sensitive columns are never read: the 04B1 list, which includes password, date of birth, address, SIN, permit and bank. A blank email or phone never clears a value.

## Rules

- **Identity** is the exact Student Number. Only surrounding spaces are trimmed; there is no prefix or leading-zero folding. A name never creates a match.
- **Name cross-check.** The identity is confirmed when every word of the shorter name appears in the longer one, exactly or one typo away (words of 4+ letters). If it fails, or there is no incoming name, the identity is not confirmed.
- **Per-field status.** Every row reports all six fields (Student Number, Name, Email, Phone, Batch / Intake, Session) as `SAFE_CONTACT_UPDATE`, `IDENTITY_REVIEW_REQUIRED` or `NO_CHANGE`:

  | Field | SAFE_CONTACT_UPDATE | IDENTITY_REVIEW_REQUIRED | NO_CHANGE |
  | --- | --- | --- | --- |
  | Email / Phone | hosted NULL, valid unshared incoming value, identity confirmed | hosted non-NULL and different; shared with another number; or a fill on a row whose identity is not confirmed | same, blank incoming (never clears), or invalid incoming (ignored, row `INVALID_CONTACT`) |
  | Student Number | never | any proposed change: a row whose number is unknown but whose name fits exactly one live student in that intake (suggestion only; a one-word name suggests nothing) | matched exactly |
  | Name | never | any difference, even a middle name or typo; a material conflict also withholds the row's contact fills | same |
  | Batch / Intake, Session | never | any difference (cohort month, batch start month and batch-name month are all accepted); this also withholds contact fills, and finance records are never moved | same, or not given / not recognised |

- **Writable fields** are `students.email` and `students.phone`, only into NULL. Values are normalized by the 04B2 rule: email trimmed and lower-cased; phone NANP `+1XXXXXXXXXX` only. Identity fields are never written by the sync.

## Classification (per incoming row, first that applies)

`MISSING_STUDENT_NUMBER` → `DUPLICATE_STUDENT_NUMBER` (twice in the file, or held by 2+ live students) → `OUT_OF_SCOPE` (unknown number whose intake is outside the scope; ignored) → `CONFLICT_REVIEW` (unknown number with a Student Number suggestion, identity not confirmed, or any `IDENTITY_REVIEW_REQUIRED` field) → `NEW_STUDENT` (unknown number, no suggestion) → `INVALID_CONTACT` → `SAFE_UPDATE` (≥ 1 `SAFE_CONTACT_UPDATE`) → `NO_CHANGE`.

A row can be `CONFLICT_REVIEW`, because its name needs review, and still carry a `SAFE_CONTACT_UPDATE` email when its identity is confirmed. The apply selects fields, not rows.

Live students no row matched are `MISSING_FROM_CURRENT_LIST`, which is reported only and never read as a withdrawal. A live student with no number is `MISSING_STUDENT_NUMBER`.

## Apply design (next ticket, not enabled)

- `--apply --plan-hash=<hash>` rebuilds the plan from the same file and the live hosted state, and refuses unless the hash matches. The hash covers the source file's sha256, all 13 table counts, the contact counts, and every scoped student's id, number, email, phone and batch.
- `safeChanges` (every `SAFE_CONTACT_UPDATE` field: email/phone into NULL) go through the existing `public.apply_student_contact_fill` RPC. The RPC locks the row, fills only a field that is still NULL, raises `STALE_TARGET` otherwise, and writes one `audit_log` row in the same transaction. This is the only automatic write.
- `reviewItems` (every `IDENTITY_REVIEW_REQUIRED` field) are never written by the sync.
  - An approved email/phone overwrite would need a reviewer's approvals file (`studentId`, `field`, `current`, `incoming`) and a new compare-and-swap RPC, which is a new migration.
  - Student Number, name, batch and session changes stay manual in v1.
- New students go through the roster/enrollment flow (finance record and schedule), not this sync. Absent students are never deleted or withdrawn.
- The plan has no shape for a finance record, installment, payment, batch move, name or number change. Post-apply invariants: every finance table count unchanged, and `audit_log` grows by exactly the number of applied changes.
