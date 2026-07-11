-- Fail the automated migration check if an exposed table loses RLS or if a
-- final-state policy reintroduces deprecated auth.role() authorization.
do $$
declare
  unprotected text;
  deprecated_policy text;
  exposed_definer text;
  mutable_path text;
begin
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname)
    into unprotected
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where (n.nspname = 'public' or (n.nspname = 'storage' and c.relname = 'objects'))
     and c.relkind in ('r', 'p')
     and not c.relrowsecurity;

  if unprotected is not null then
    raise exception 'Exposed tables without RLS: %', unprotected;
  end if;

  select string_agg(format('%I.%I:%I', schemaname, tablename, policyname), ', ')
    into deprecated_policy
    from pg_policies
   where schemaname in ('public', 'storage')
     and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) like '%auth.role()%';

  if deprecated_policy is not null then
    raise exception 'Policies still use deprecated auth.role(): %', deprecated_policy;
  end if;

  select string_agg(p.proname, ', ' order by p.proname)
    into exposed_definer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and (
       has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute')
     );

  if exposed_definer is not null then
    raise exception 'Exposed SECURITY DEFINER functions: %', exposed_definer;
  end if;

  select string_agg(p.proname, ', ' order by p.proname)
    into mutable_path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (
       select 1 from pg_depend d
       where d.classid = 'pg_proc'::regclass
         and d.objid = p.oid
         and d.deptype = 'e'
     )
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, array[]::text[])) setting
       where setting like 'search_path=%'
     );

  if mutable_path is not null then
    raise exception 'Public functions with mutable search_path: %', mutable_path;
  end if;
end
$$;
