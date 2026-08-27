-- Record a phone number when an operator has no email address.
create or replace function public.spc_note_entity_change(
  p_type text, p_id text, p_before jsonb, p_after jsonb, p_version bigint
) returns void language plpgsql security definer set search_path=public as $$
declare
  actor uuid:=auth.uid();
  actor_email text:=coalesce(
    nullif(auth.jwt()->'user_metadata'->>'local_phone',''),
    nullif(auth.jwt()->>'email',''),
    nullif(auth.jwt()->>'phone',''),
    'unknown'
  );
  action_name text;
begin
  if p_before is not distinct from p_after then return; end if;
  action_name:=case when p_before is null then 'CREATE' when p_after is null then 'DELETE' else 'UPDATE' end;
  if p_after is not null then
    insert into spc_entity_activity(workspace_id,entity_type,entity_id,created_by,created_by_email,updated_by,updated_by_email)
    values('main',p_type,p_id,actor,actor_email,actor,actor_email)
    on conflict(workspace_id,entity_type,entity_id) do update
      set updated_by=excluded.updated_by,updated_by_email=excluded.updated_by_email,updated_at=now();
  end if;
  insert into spc_audit_logs(workspace_id,action,entity_type,entity_id,detail)
    values('main',action_name,p_type,p_id,jsonb_build_object(
      'version',p_version,'user_id',actor,'user_email',actor_email,
      'changed_at',now(),'before',p_before,'after',p_after));
end;
$$;

revoke all on function public.spc_note_entity_change(text,text,jsonb,jsonb,bigint) from public;
