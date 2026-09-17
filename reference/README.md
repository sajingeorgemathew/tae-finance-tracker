# Reference files — do not edit

This directory holds the **source of truth** files the finance system was built
from. They are inputs, not application data.

| File | What it is |
| --- | --- |
| `finance-tracker.xlsx.xlsx` | The historical finance workbook (batches, payments, balances, receipt status). |
| `receipt-template.pdf.pdf` | The existing receipt layout the generated PDF receipts must match. |

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
