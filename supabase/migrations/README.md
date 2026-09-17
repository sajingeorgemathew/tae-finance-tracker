# supabase/migrations

SQL migrations, applied in filename order.

Empty in FINANCE-BOOTSTRAP-00 on purpose: no finance tables, no receipt tables
and no audit tables are created by this ticket. Authentication uses Supabase's
built-in `auth` schema, which needs no migration.
