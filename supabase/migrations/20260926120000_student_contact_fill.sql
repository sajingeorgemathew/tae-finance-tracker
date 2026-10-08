-- =============================================================================
-- FINANCE-CONTACT-04B2 — atomic student contact fill
-- =============================================================================
-- One function, `public.apply_student_contact_fill`, that fills a hosted
-- student's NULL email and/or NULL phone and writes the matching audit_log
-- entry inside one transaction. It exists so a contact apply can never leave
-- a student changed without its audit row, or an audit row without its change:
-- a PL/pgSQL function body runs inside the caller's transaction, and any
-- exception raised anywhere in it rolls back everything the body did. Through
-- PostgREST each RPC call is its own transaction, so the two statements below
-- succeed or fail together with no client-side ordering to get wrong.
--
-- Safety rules the function enforces on its own, whatever the caller says:
--
--   * caller must be authenticated (auth.uid() not NULL) and must pass
--     public.can_write_finance() — admin or finance; a viewer, a deactivated
--     profile and an anonymous caller are all rejected before any row is read;
--   * a student UUID is required, and at least one of email/phone must be
--     proposed; a call proposing neither is rejected;
--   * the target row is locked (SELECT … FOR UPDATE) and re-read at execution
--     time. A requested field that is no longer NULL raises STALE_TARGET and
--     nothing is written — a plan built earlier can never overwrite a value
--     somebody entered in between;
--   * a non-NULL email or phone is NEVER overwritten, by construction: the
--     UPDATE only assigns a field that was requested, and only when the locked
--     row still holds NULL in it;
--   * the stored forms are checked: email must already be trimmed and lower
--     case and shaped like an address; phone must be canonical NANP
--     `+1XXXXXXXXXX` (area code and exchange 2–9). Ambiguous or international
--     values are refused here as well as in the planner;
--   * `p_expected_student_number`, when given, must equal the locked row's
--     student_number — a guard against a plan row pointing at the wrong UUID;
--   * exactly one audit_log row is inserted, attributed to auth.uid();
--     before_data / after_data carry only the fields involved in this call.
--
-- Security model: SECURITY INVOKER (the default, stated explicitly). The
-- function runs as the calling role with the caller's JWT, so the existing
-- RLS policies on public.students (update: can_write_finance) and
-- public.audit_log (insert: can_write_finance and actor = auth.uid()) apply
-- unchanged. No elevation, no service role, no dynamic SQL, every reference
-- schema-qualified, `search_path = ''`. EXECUTE is revoked from PUBLIC and
-- anon and granted to authenticated only.
--
-- No DELETE capability is added anywhere. Nothing here touches names,
-- student numbers, batches, sessions, finance records or payments.
--
-- Additive: one function and its grants. No table, column, row, policy or
-- earlier migration is altered.
--
-- Rollback / removal: `drop function public.apply_student_contact_fill(uuid,
-- text, text, text, jsonb);` — a later reviewed migration; dropping it does
-- not undo any contact fill, which stays recorded in audit_log.
-- =============================================================================


create or replace function public.apply_student_contact_fill(
  p_student_id              uuid,
  p_email                   text  default null,
  p_phone                   text  default null,
  p_expected_student_number text  default null,
  p_metadata                jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_student  public.students%rowtype;
  v_updated  public.students%rowtype;
  v_before   jsonb  := '{}'::jsonb;
  v_after    jsonb  := '{}'::jsonb;
  v_fields   text[] := '{}'::text[];
  v_audit_id uuid;
begin
  -- 1. Who is calling. Both checks happen before any table is read.
  if v_actor is null then
    raise exception 'NOT_AUTHENTICATED'
      using errcode = '42501',
            detail  = 'apply_student_contact_fill requires an authenticated caller';
  end if;

  if not public.can_write_finance() then
    raise exception 'NOT_AUTHORISED'
      using errcode = '42501',
            detail  = 'apply_student_contact_fill requires the admin or finance role';
  end if;

  -- 2. What is being asked.
  if p_student_id is null then
    raise exception 'STUDENT_ID_REQUIRED'
      using errcode = '22004';
  end if;

  if p_email is null and p_phone is null then
    raise exception 'NO_FIELD_REQUESTED'
      using errcode = '22023',
            detail  = 'at least one of p_email, p_phone must be proposed';
  end if;

  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'METADATA_NOT_OBJECT'
      using errcode = '22023';
  end if;

  -- 3. Storage normalization, enforced here as well as in the planner.
  if p_email is not null and (
       p_email <> lower(btrim(p_email))
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'INVALID_EMAIL'
      using errcode = '22023',
            detail  = 'email must be trimmed, lower case and shaped like an address';
  end if;

  if p_phone is not null and p_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$' then
    raise exception 'INVALID_PHONE'
      using errcode = '22023',
            detail  = 'phone must be canonical NANP +1XXXXXXXXXX';
  end if;

  -- 4. Lock and re-read the target. RLS applies (SECURITY INVOKER).
  select * into v_student
  from public.students s
  where s.id = p_student_id
  for update;

  if not found then
    raise exception 'STUDENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if p_expected_student_number is not null
     and v_student.student_number is distinct from p_expected_student_number then
    raise exception 'STUDENT_NUMBER_MISMATCH'
      using errcode = 'P0001',
            detail  = 'the locked row does not carry the student number the plan expected';
  end if;

  -- 5. Stale-target protection: a requested field must still be NULL now.
  if p_email is not null then
    if v_student.email is not null then
      raise exception 'STALE_TARGET'
        using errcode = 'P0001',
              detail  = 'email is no longer NULL; nothing was written';
    end if;
    v_before := v_before || jsonb_build_object('email', null);
    v_after  := v_after  || jsonb_build_object('email', p_email);
    v_fields := v_fields || 'email'::text;
  end if;

  if p_phone is not null then
    if v_student.phone is not null then
      raise exception 'STALE_TARGET'
        using errcode = 'P0001',
              detail  = 'phone is no longer NULL; nothing was written';
    end if;
    v_before := v_before || jsonb_build_object('phone', null);
    v_after  := v_after  || jsonb_build_object('phone', p_phone);
    v_fields := v_fields || 'phone'::text;
  end if;

  -- 6. The update: only the requested fields, only while still NULL.
  --    Every other column is untouched (updated_at is stamped by the
  --    existing students_set_updated_at trigger, as for any update).
  update public.students s
     set email = case when p_email is not null then p_email else s.email end,
         phone = case when p_phone is not null then p_phone else s.phone end
   where s.id = p_student_id
     and (p_email is null or s.email is null)
     and (p_phone is null or s.phone is null)
  returning s.* into v_updated;

  if not found then
    -- Cannot happen after the FOR UPDATE checks above; kept so a future
    -- policy change can never turn a silent no-op into a claimed success.
    raise exception 'STALE_TARGET'
      using errcode = 'P0001',
            detail  = 'the row changed between lock and update; nothing was written';
  end if;

  -- 7. Exactly one audit row, attributed to the caller. Same transaction.
  insert into public.audit_log (
    actor_user_id, entity_type, entity_id, action, before_data, after_data, metadata
  )
  values (
    v_actor,
    'student',
    p_student_id,
    'contact_fill',
    v_before,
    v_after,
    coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object('rpc', 'apply_student_contact_fill', 'fields', to_jsonb(v_fields))
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'student_id',     p_student_id,
    'student_number', v_updated.student_number,
    'audit_log_id',   v_audit_id,
    'actor_user_id',  v_actor,
    'fields',         to_jsonb(v_fields),
    'before',         v_before,
    'after',          v_after,
    'updated_at',     v_updated.updated_at
  );
end;
$$;

comment on function public.apply_student_contact_fill(uuid, text, text, text, jsonb) is
  'FINANCE-CONTACT-04B2: fills a student''s NULL email and/or phone and inserts one audit_log row in the same transaction. SECURITY INVOKER; never overwrites a non-NULL value (STALE_TARGET); admin/finance only.';


-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Postgres grants EXECUTE on a new function to PUBLIC automatically. Revoke
-- that and grant to authenticated only: anon can never reach the function,
-- and an authenticated caller still has to pass the role check inside it.

revoke all on function public.apply_student_contact_fill(uuid, text, text, text, jsonb)
from public, anon;

grant execute on function public.apply_student_contact_fill(uuid, text, text, text, jsonb)
to authenticated;


-- Verify (structure only, never student data):
--   select proname, prosecdef, proconfig
--   from pg_proc
--   where pronamespace = 'public'::regnamespace and proname = 'apply_student_contact_fill';
--
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_schema = 'public' and routine_name = 'apply_student_contact_fill'
--   order by grantee;
