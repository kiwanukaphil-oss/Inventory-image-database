-- Behavioral verification of 0027 (run with ON_ERROR_STOP=0; read ERROR lines
-- as PASS where a failure is expected). Identities are simulated via test.uid +
-- SET ROLE authenticated so RLS + triggers behave as in production.
\set ADMIN   '''11111111-1111-1111-1111-111111111111'''
\set MGR     '''22222222-2222-2222-2222-222222222222'''
\set EDITOR  '''33333333-3333-3333-3333-333333333333'''
\set ITEM    '''99999999-9999-9999-9999-999999999999'''

-- ---- setup (as postgres: RLS bypassed, self-escalation trigger exempt) ----
delete from public.item_events; delete from public.audit_log;
delete from public.item_costs; delete from public.items; delete from public.profiles; delete from auth.users;

insert into auth.users(id,email) values
 (:ADMIN,'admin@test'),(:MGR,'manager@test'),(:EDITOR,'editor@test');
-- handle_new_user already created viewer profiles; grant capabilities:
update public.profiles set role='admin', can_upload=true,can_edit=true,can_delete=true,can_view_cost=true,can_manage_users=true where id=:ADMIN;
update public.profiles set role='custom',can_upload=true,can_edit=true,can_delete=false,can_view_cost=false,can_manage_users=true where id=:MGR;
update public.profiles set role='editor',can_upload=true,can_edit=true,can_delete=false,can_view_cost=false,can_manage_users=false where id=:EDITOR;

insert into public.items(id,category_id,brand,price,stock_quantity,attributes)
  values (:ITEM,(select id from public.categories order by slug limit 1),'SEED',100,1,'{}');

\echo ''
\echo '################ S1 — self-escalation ################'
select set_config('test.uid',:MGR,false);
set role authenticated;
\echo '-- S1a manager self-grants can_view_cost  [EXPECT: ERROR]'
update public.profiles set can_view_cost=true where id=:MGR;
\echo '-- S1b manager self-promotes to admin     [EXPECT: ERROR]'
update public.profiles set role='admin' where id=:MGR;
\echo '-- S1c manager edits ANOTHER user caps     [EXPECT: UPDATE 1]'
update public.profiles set can_edit=true where id=:EDITOR;
\echo '-- S1d manager edits own email (non-priv)   [EXPECT: UPDATE 1]'
update public.profiles set email='m2@test' where id=:MGR;
reset role;

\echo ''
\echo '################ baseline — non-manager cannot write profiles ################'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
\echo '-- editor edits another profile            [EXPECT: UPDATE 0]'
update public.profiles set can_edit=true where id=:ADMIN;
reset role;

\echo ''
\echo '################ S3 — cost never persists in item_events ################'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
\echo '-- editor inserts cost_price event WITH values'
insert into public.item_events(item_id,event_type,source,field_path,before_value,after_value,summary)
  values (:ITEM,'manual_edit','manual','cost_price','"100"'::jsonb,'"200"'::jsonb,'cost changed');
\echo '-- stored values                           [EXPECT: both NULL]'
select before_value, after_value from public.item_events where field_path='cost_price' order by id desc limit 1;
reset role;

\echo ''
\echo '################ S8 — actor cannot be spoofed ################'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
\echo '-- editor inserts event claiming actor=MANAGER'
insert into public.item_events(item_id,event_type,source,field_path,actor,summary)
  values (:ITEM,'manual_edit','manual','status',:MGR::uuid,'spoof attempt');
\echo '-- recorded actor                          [EXPECT: editor 3333..., NOT 2222...]'
select actor from public.item_events where summary='spoof attempt' order by id desc limit 1;
reset role;

\echo ''
\echo '################ S8 — audit_log append-only ################'
\echo '-- editor (authenticated) updates audit_log [EXPECT: ERROR permission/append-only]'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
update public.audit_log set after='hacked';
reset role;
\echo '-- service_role updates audit_log           [EXPECT: ERROR append-only trigger]'
set role service_role;
update public.audit_log set after='hacked';
\echo '-- service_role deletes audit_log           [EXPECT: ERROR append-only trigger]'
delete from public.audit_log;
reset role;

\echo ''
\echo '################ S7 — constraints ################'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
\echo '-- negative price                          [EXPECT: ERROR check]'
insert into public.items(category_id,brand,price,stock_quantity)
  values ((select id from public.categories order by slug limit 1),'NEG',-5,1);
\echo '-- null category                           [EXPECT: ERROR not null]'
insert into public.items(brand,price,stock_quantity) values ('NOCAT',10,1);
\echo '-- duplicate SKU allowed'
insert into public.items(category_id,brand,price,stock_quantity,attributes)
  values ((select id from public.categories order by slug limit 1),'DUP',10,1,'{"color":"Red","size":"32"}');
insert into public.items(category_id,brand,price,stock_quantity,attributes)
  values ((select id from public.categories order by slug limit 1),'DUP',10,1,'{"color":"Red","size":"32"}');
\echo '-- same SKU on 2 rows                       [EXPECT: count = 2]'
select sku, count(*) from public.items where brand='DUP' group by sku;
reset role;
\echo ''
\echo '################ DONE ################'
