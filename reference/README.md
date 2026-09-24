# Reference files — do not edit

This directory holds the **source of truth** files the finance system was built
from. They are inputs, not application data.

| File | What it is |
| --- | --- |
| `finance-tracker.xlsx.xlsx` | The historical finance workbook (batches, payments, balances, receipt status). Authoritative for finance history. Identified by its `Tracker Master` sheet. |
| `PSW MASTERCLASS LIST- 2025 - 26 (6).xlsx` | The PSW contact/roster master (one sheet per intake, Morning and Evening tables). Contact evidence only; see `docs/FINANCE-CONTACT-04B1.md`. |
| `ELCE_MASTERCLASS_LIST_2025-26_New#.xlsx` | The ECEA contact/roster master (a master sheet plus Weekday/Weekend subset sheets). Contact evidence only. |
| `receipt-template.pdf.pdf` | The existing receipt layout the generated PDF receipts must match. |

The contact masters carry columns the application must never import
(passwords, dates of birth, addresses, immigration and placement details).
The contact importer reads only an explicit allowlist of headings; everything
else is ignored by name. They are import evidence, not runtime infrastructure:
no mailing or export workflow may read them at run time.

## Rules

1. **Never edit, rename, reformat, or overwrite these files.** Filenames are
   preserved exactly as received, including the doubled extensions.
2. **Application code must never write to this directory.** It may only ever
   open these files read-only, and only from server-side code.
3. **Do not "clean" the workbook.** Historical data is imported AS-IS.
   Corrections, de-duplication and reconciliation are separate, deliberate,
   audited operations — not silent fixes during an import.
4. **These files are excluded from Git.** They contain real student names,
   student IDs and payment balances. See the `/reference` rules in
   `.gitignore`; only this README is tracked.

If a copy is needed for experimentation, copy it out of this directory first and
work on the copy.
