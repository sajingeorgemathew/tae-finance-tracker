# lib/finance

Server-side finance data access. Every module here imports `server-only` and
uses the request-scoped Supabase client, so reads run with the signed-in user's
own privileges and Row Level Security is the authorization boundary. Nothing
here touches the service-role key.

| Module | Contents |
| --- | --- |
| `query.ts` | Shared paging, search escaping and error handling. Driver errors are logged, never returned. |
| `programs.ts` | Program configuration reads. Programs are admin-write; no write helper exists yet. |
| `batches.ts` | Batch reads, including lookup by legacy worksheet name. |
| `students.ts` | Student reads, search, and `studentDisplayName()`. |
| `finance-records.ts` | Finance records with student/program/batch attached, plus a head count. |
| `notes.ts` | Pure note resolution: `effectiveNote()` and `defaultNoteFor()`. No database access. |

Two rules this directory exists to enforce:

1. **Legacy values are never recomputed.** `legacy_*` columns are what the
   workbook said. A calculated figure is a separate, separately-labelled number.
2. **Notes resolve to `custom_note ?? default_note`.** Read them through
   `effectiveNote()`; never render `custom_note` directly.

Not here yet, by ticket scope: receipt numbering and PDF generation
(FINANCE-RECEIPTS), workbook import (FINANCE-IMPORT-02), email delivery, and any
generic CRUD surface. Write paths arrive with the screens that need them.
