-- =============================================================================
-- FINANCE-CONTACT-04B2 — verification of public.apply_student_contact_fill
-- =============================================================================
-- Run against the linked project with:
--
--   npx supabase db query --linked -f scripts/finance-contact/rpc-verification.sql
--
-- Everything happens inside ONE DO block that ends by raising an exception,
-- so every fixture row and every test write is rolled back: the hosted
-- students, audit_log and profiles are exactly as before when it finishes.
-- The report travels in the exception message as a JSON array of
-- {case, ok, note}. Expected: every `ok` true, and the CLI prints the message
-- as an error (that is the rollback, not a failure).
--
-- Fixtures are invented (example.test addresses, 555 numbers, T04B2-* student
-- numbers) and never reach a committed file beyond this one. No auth user is
-- created and no profile is changed: the writer identity is the existing
-- active admin's uid (claims only, no password, no token); the non-writer is
-- a random uid with no profile; the unauthenticated caller has no claims.
--
-- Cases (ticket §22): A email fill · B phone fill · C both, one audit row ·
-- D existing email rejected (and phone-only on that row still allowed) ·
-- E existing phone rejected, and a combined request writes nothing ·
-- F both NULL rejected · G non-writer rejected · H unauthenticated rejected
-- (as anon: no EXECUTE; as authenticated with no claims: NOT_AUTHENTICATED) ·
-- I writer allowed (admin; see note on finance) · J actor = auth.uid() ·
-- K no audit row when the update fails · L no student update when the audit
-- insert fails · M unrelated columns unchanged · plus normalization and
-- identity guards.

do $$
declare
  v_admin   uuid;
  v_nobody  uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();
  v_e uuid := gen_random_uuid();
  v_f uuid := gen_random_uuid();
  v_k uuid := gen_random_uuid();
  v_l uuid := gen_random_uuid();
  v_students_before bigint;
  v_audit_before    bigint;
  v_report jsonb := '[]'::jsonb;
  v_result jsonb;
  v_row    public.students%rowtype;
  v_orig   public.students%rowtype;
  v_n      bigint;
  v_msg    text;
  v_detail text;
  v_state  text;
  v_actor  uuid;
  v_before jsonb;
  v_after  jsonb;
  v_meta   jsonb;
begin
  select p.id into v_admin
  from public.profiles p
  where p.role = 'admin' and p.active
  order by p.created_at
  limit 1;
  if v_admin is null then
    raise exception 'no active admin profile to run the verification as';
  end if;

  select count(*) into v_students_before from public.students;
  select count(*) into v_audit_before from public.audit_log;

  -- Fixtures, inserted as the migration role before any role switch.
  insert into public.students (id, student_number, first_name, last_name, legacy_name, legacy_source, email, phone) values
    (v_a, 'T04B2-A', 'Fixture', 'A', 'Fixture A', 'rpc-verification', null, null),
    (v_b, 'T04B2-B', 'Fixture', 'B', 'Fixture B', 'rpc-verification', null, null),
    (v_c, 'T04B2-C', 'Fixture', 'C', 'Fixture C', 'rpc-verification', null, null),
    (v_d, 'T04B2-D', 'Fixture', 'D', 'Fixture D', 'rpc-verification', 'existing.d@example.test', null),
    (v_e, 'T04B2-E', 'Fixture', 'E', 'Fixture E', 'rpc-verification', null, '+14165550105'),
    (v_f, 'T04B2-F', 'Fixture', 'F', 'Fixture F', 'rpc-verification', null, null),
    (v_k, 'T04B2-K', 'Fixture', 'K', 'Fixture K', 'rpc-verification', null, null),
    (v_l, 'T04B2-L', 'Fixture', 'L', 'Fixture L', 'rpc-verification', null, null);

  -- ---------------------------------------------------------------------------
  -- A. email NULL -> fills email + one audit row
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_a, 'fixture.a@example.test', null, 'T04B2-A', '{"test":"A"}'::jsonb);
    execute 'reset role';
    select * into v_row from public.students where id = v_a;
    select count(*) into v_n from public.audit_log where entity_type = 'student' and entity_id = v_a and action = 'contact_fill';
    select actor_user_id, before_data, after_data, metadata into v_actor, v_before, v_after, v_meta
      from public.audit_log where entity_id = v_a order by created_at desc limit 1;
    v_report := v_report || jsonb_build_object('case', 'A email fill', 'ok',
      v_row.email = 'fixture.a@example.test' and v_row.phone is null and v_n = 1
      and v_before = '{"email": null}'::jsonb and v_after = '{"email": "fixture.a@example.test"}'::jsonb
      and v_meta->>'test' = 'A' and v_meta->'fields' = '["email"]'::jsonb and v_meta->>'rpc' = 'apply_student_contact_fill'
      and (v_result->>'audit_log_id')::uuid is not null and v_result->'fields' = '["email"]'::jsonb,
      'note', 'email set, phone untouched, exactly one audit row with before/after limited to email');
    v_report := v_report || jsonb_build_object('case', 'J actor_user_id = auth.uid()', 'ok', v_actor = v_admin and (v_result->>'actor_user_id')::uuid = v_admin, 'note', 'audit row attributed to the calling admin');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'A email fill', 'ok', false, 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- B. phone NULL -> fills phone + audit
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_b, null, '+14165550102', 'T04B2-B', '{"test":"B"}'::jsonb);
    execute 'reset role';
    select * into v_row from public.students where id = v_b;
    select count(*) into v_n from public.audit_log where entity_id = v_b;
    select before_data, after_data into v_before, v_after from public.audit_log where entity_id = v_b;
    v_report := v_report || jsonb_build_object('case', 'B phone fill', 'ok',
      v_row.phone = '+14165550102' and v_row.email is null and v_n = 1
      and v_before = '{"phone": null}'::jsonb and v_after = '{"phone": "+14165550102"}'::jsonb,
      'note', 'phone set, email untouched, one audit row limited to phone');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'B phone fill', 'ok', false, 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- C. both NULL -> fills both + ONE audit row; M. unrelated columns unchanged
  -- ---------------------------------------------------------------------------
  begin
    select * into v_orig from public.students where id = v_c;
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_c, 'fixture.c@example.test', '+14165550103', 'T04B2-C', '{"test":"C"}'::jsonb);
    execute 'reset role';
    select * into v_row from public.students where id = v_c;
    select count(*) into v_n from public.audit_log where entity_id = v_c;
    select before_data, after_data into v_before, v_after from public.audit_log where entity_id = v_c;
    v_report := v_report || jsonb_build_object('case', 'C both fill, one audit row', 'ok',
      v_row.email = 'fixture.c@example.test' and v_row.phone = '+14165550103' and v_n = 1
      and v_before = '{"email": null, "phone": null}'::jsonb
      and v_after = '{"email": "fixture.c@example.test", "phone": "+14165550103"}'::jsonb,
      'note', 'both set in one call; exactly one audit row carrying both fields');
    v_report := v_report || jsonb_build_object('case', 'M unrelated columns unchanged', 'ok',
      v_row.student_number = v_orig.student_number and v_row.first_name = v_orig.first_name
      and v_row.last_name = v_orig.last_name and v_row.legacy_name = v_orig.legacy_name
      and v_row.legacy_source = v_orig.legacy_source and v_row.active = v_orig.active
      and v_row.created_at = v_orig.created_at and v_row.middle_name is not distinct from v_orig.middle_name
      and v_row.display_name is not distinct from v_orig.display_name
      and v_row.updated_at >= v_orig.updated_at,
      'note', 'names, number, legacy fields, active and created_at identical; updated_at stamped by the existing trigger');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'C both fill, one audit row', 'ok', false, 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- D. existing email non-NULL -> requested email rejected (STALE_TARGET)
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_d, 'other.d@example.test', null, 'T04B2-D', '{"test":"D"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'D existing email rejected', 'ok', false, 'note', 'call succeeded but must have raised STALE_TARGET');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
    select * into v_row from public.students where id = v_d;
    select count(*) into v_n from public.audit_log where entity_id = v_d;
    v_report := v_report || jsonb_build_object('case', 'D existing email rejected', 'ok',
      v_msg = 'STALE_TARGET' and v_row.email = 'existing.d@example.test' and v_n = 0,
      'note', v_msg || ' — ' || coalesce(v_detail, ''));
  end;

  -- D2. the same row still accepts a phone-only fill (field-level eligibility)
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_d, null, '+14165550104', 'T04B2-D', '{"test":"D2"}'::jsonb);
    execute 'reset role';
    select * into v_row from public.students where id = v_d;
    select count(*) into v_n from public.audit_log where entity_id = v_d;
    select before_data, after_data into v_before, v_after from public.audit_log where entity_id = v_d;
    v_report := v_report || jsonb_build_object('case', 'D2 phone-only fill on a row with an existing email', 'ok',
      v_row.email = 'existing.d@example.test' and v_row.phone = '+14165550104' and v_n = 1
      and v_before = '{"phone": null}'::jsonb and v_after = '{"phone": "+14165550104"}'::jsonb,
      'note', 'existing email kept, phone filled, audit row mentions phone only');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'D2 phone-only fill on a row with an existing email', 'ok', false, 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- E. existing phone non-NULL -> phone rejected; a combined request writes NOTHING
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_e, 'fixture.e@example.test', '+14165550199', 'T04B2-E', '{"test":"E"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'E existing phone rejected, combined request atomic', 'ok', false, 'note', 'call succeeded but must have raised STALE_TARGET');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    select * into v_row from public.students where id = v_e;
    select count(*) into v_n from public.audit_log where entity_id = v_e;
    v_report := v_report || jsonb_build_object('case', 'E existing phone rejected, combined request atomic', 'ok',
      v_msg = 'STALE_TARGET' and v_row.phone = '+14165550105' and v_row.email is null and v_n = 0,
      'note', v_msg || ' — email was NOT written even though it was NULL, because the call failed as a whole');
  end;

  -- ---------------------------------------------------------------------------
  -- F. both proposed NULL -> rejected
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, null, null, 'T04B2-F', '{"test":"F"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'F both NULL rejected', 'ok', false, 'note', 'call succeeded but must have raised NO_FIELD_REQUESTED');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    select count(*) into v_n from public.audit_log where entity_id = v_f;
    v_report := v_report || jsonb_build_object('case', 'F both NULL rejected', 'ok', v_msg = 'NO_FIELD_REQUESTED' and v_n = 0, 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- G. authenticated caller without a writer profile -> rejected
  --    (a real viewer account cannot be minted here without creating an auth
  --    user; a uid with no active admin/finance profile fails the same
  --    can_write_finance() check a viewer fails)
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_nobody::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, 'fixture.f@example.test', null, 'T04B2-F', '{"test":"G"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'G non-writer rejected', 'ok', false, 'note', 'call succeeded but must have raised NOT_AUTHORISED');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    select * into v_row from public.students where id = v_f;
    v_report := v_report || jsonb_build_object('case', 'G non-writer rejected', 'ok', v_msg = 'NOT_AUTHORISED' and v_state = '42501' and v_row.email is null, 'note', v_msg || ' (' || v_state || ')');
  end;

  -- ---------------------------------------------------------------------------
  -- H. unauthenticated -> rejected. Two shapes: anon role (no EXECUTE at all),
  --    and authenticated role with no JWT claims (NOT_AUTHENTICATED).
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    execute 'set local role anon';
    v_result := public.apply_student_contact_fill(v_f, 'fixture.f@example.test', null, 'T04B2-F', '{"test":"H1"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'H1 anon has no EXECUTE', 'ok', false, 'note', 'anon could execute the function');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    v_report := v_report || jsonb_build_object('case', 'H1 anon has no EXECUTE', 'ok', v_state = '42501', 'note', v_msg || ' (' || v_state || ')');
  end;

  begin
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, 'fixture.f@example.test', null, 'T04B2-F', '{"test":"H2"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'H2 no claims -> NOT_AUTHENTICATED', 'ok', false, 'note', 'call succeeded without a uid');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    select * into v_row from public.students where id = v_f;
    v_report := v_report || jsonb_build_object('case', 'H2 no claims -> NOT_AUTHENTICATED', 'ok', v_msg = 'NOT_AUTHENTICATED' and v_row.email is null, 'note', v_msg || ' (' || v_state || ')');
  end;

  -- ---------------------------------------------------------------------------
  -- Normalization and identity guards
  -- ---------------------------------------------------------------------------
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, 'Fixture.F@Example.test', null, 'T04B2-F', '{"test":"N1"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'N1 non-canonical email rejected', 'ok', false, 'note', 'accepted an upper-case email');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'N1 non-canonical email rejected', 'ok', v_msg = 'INVALID_EMAIL', 'note', v_msg);
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, null, '4165550106', 'T04B2-F', '{"test":"N2"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'N2 non-canonical phone rejected', 'ok', false, 'note', 'accepted a phone without +1');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'N2 non-canonical phone rejected', 'ok', v_msg = 'INVALID_PHONE', 'note', v_msg);
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, null, '+441632960000', 'T04B2-F', '{"test":"N3"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'N3 non-NANP phone rejected', 'ok', false, 'note', 'accepted an international number');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'N3 non-NANP phone rejected', 'ok', v_msg = 'INVALID_PHONE', 'note', v_msg);
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_f, 'fixture.f@example.test', null, 'T04B2-WRONG', '{"test":"N4"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'N4 student number mismatch rejected', 'ok', false, 'note', 'wrote despite a mismatching expected number');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    select * into v_row from public.students where id = v_f;
    v_report := v_report || jsonb_build_object('case', 'N4 student number mismatch rejected', 'ok', v_msg = 'STUDENT_NUMBER_MISMATCH' and v_row.email is null, 'note', v_msg);
  end;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(gen_random_uuid(), 'fixture.x@example.test', null, null, '{"test":"N5"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'N5 unknown student rejected', 'ok', false, 'note', 'wrote to a missing uuid');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    v_report := v_report || jsonb_build_object('case', 'N5 unknown student rejected', 'ok', v_msg = 'STUDENT_NOT_FOUND', 'note', v_msg);
  end;

  -- ---------------------------------------------------------------------------
  -- K. the UPDATE fails -> no audit row, student unchanged
  --    (a temporary trigger, created inside this rolled-back transaction, makes
  --    the update of fixture K raise)
  -- ---------------------------------------------------------------------------
  create function public.t04b2_fail_update() returns trigger language plpgsql as $t$
  begin
    raise exception 'T04B2_FORCED_UPDATE_FAILURE';
  end $t$;
  create trigger t04b2_k_fail before update on public.students
    for each row when (old.student_number = 'T04B2-K') execute function public.t04b2_fail_update();
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_k, 'fixture.k@example.test', '+14165550111', 'T04B2-K', '{"test":"K"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'K update failure leaves no audit row', 'ok', false, 'note', 'the forced update failure did not raise');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    select * into v_row from public.students where id = v_k;
    select count(*) into v_n from public.audit_log where entity_id = v_k;
    v_report := v_report || jsonb_build_object('case', 'K update failure leaves no audit row', 'ok',
      v_msg = 'T04B2_FORCED_UPDATE_FAILURE' and v_n = 0 and v_row.email is null and v_row.phone is null, 'note', v_msg || '; audit rows for K: ' || v_n);
  end;
  drop trigger t04b2_k_fail on public.students;
  drop function public.t04b2_fail_update();

  -- ---------------------------------------------------------------------------
  -- L. the audit INSERT fails -> no student update
  -- ---------------------------------------------------------------------------
  create function public.t04b2_fail_audit() returns trigger language plpgsql as $t$
  begin
    if new.metadata->>'test' = 'L' then
      raise exception 'T04B2_FORCED_AUDIT_FAILURE';
    end if;
    return new;
  end $t$;
  create trigger t04b2_l_fail before insert on public.audit_log
    for each row execute function public.t04b2_fail_audit();
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';
    v_result := public.apply_student_contact_fill(v_l, 'fixture.l@example.test', '+14165550112', 'T04B2-L', '{"test":"L"}'::jsonb);
    execute 'reset role';
    v_report := v_report || jsonb_build_object('case', 'L audit failure leaves the student unchanged', 'ok', false, 'note', 'the forced audit failure did not raise');
  exception when others then
    execute 'reset role';
    get stacked diagnostics v_msg = message_text;
    select * into v_row from public.students where id = v_l;
    select count(*) into v_n from public.audit_log where entity_id = v_l;
    v_report := v_report || jsonb_build_object('case', 'L audit failure leaves the student unchanged', 'ok',
      v_msg = 'T04B2_FORCED_AUDIT_FAILURE' and v_n = 0 and v_row.email is null and v_row.phone is null, 'note', v_msg || '; student L email/phone still NULL');
  end;
  drop trigger t04b2_l_fail on public.audit_log;
  drop function public.t04b2_fail_audit();

  -- ---------------------------------------------------------------------------
  -- Conservation inside the transaction: fixtures + successful writes only.
  -- ---------------------------------------------------------------------------
  select count(*) into v_n from public.students;
  v_report := v_report || jsonb_build_object('case', 'students = before + 8 fixtures (inside the transaction)', 'ok', v_n = v_students_before + 8, 'note', v_n::text);
  select count(*) into v_n from public.audit_log;
  v_report := v_report || jsonb_build_object('case', 'audit_log = before + 4 successful fills (A, B, C, D2)', 'ok', v_n = v_audit_before + 4, 'note', v_n::text);
  select count(*) into v_n from public.audit_log where actor_user_id is distinct from v_admin;
  v_report := v_report || jsonb_build_object('case', 'no audit row attributed to anyone but the admin', 'ok', v_n = 0, 'note', v_n::text);

  -- ---------------------------------------------------------------------------
  -- Roll everything back. The message is the report.
  -- ---------------------------------------------------------------------------
  raise exception 'T04B2_RPC_VERIFICATION ROLLED BACK — report: %', jsonb_pretty(
    jsonb_build_object(
      'all_ok', not exists (select 1 from jsonb_array_elements(v_report) e where (e->>'ok')::boolean is distinct from true),
      'cases', v_report
    ));
end $$;
