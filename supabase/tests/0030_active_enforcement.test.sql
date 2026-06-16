-- S9: a deactivated account (active=false) must be denied at the DB even with a
-- valid session. S12 shares the same capability helpers, so this also exercises
-- the active-aware helper change.
\set ACT   '''44444444-4444-4444-4444-444444444444'''
\set INACT '''55555555-5555-5555-5555-555555555555'''

delete from public.items; delete from public.profiles; delete from auth.users;
insert into auth.users(id,email) values (:ACT,'act@t'),(:INACT,'inact@t');
update public.profiles set can_upload=true, can_edit=true, active=true  where id=:ACT;
update public.profiles set can_upload=true, can_edit=true, active=false where id=:INACT;
insert into public.items(category_id,brand,price,stock_quantity)
  values ((select id from public.categories order by slug limit 1),'SEED',100,1);

\echo '-- ACTIVE editor reads items        [EXPECT: 1]'
select set_config('test.uid',:ACT,false);
set role authenticated;
select count(*) as active_reads from public.items;
reset role;

\echo '-- INACTIVE editor reads items      [EXPECT: 0]'
select set_config('test.uid',:INACT,false);
set role authenticated;
select count(*) as inactive_reads from public.items;
\echo '-- INACTIVE editor inserts item     [EXPECT: ERROR row-level security]'
insert into public.items(category_id,brand,price,stock_quantity)
  values ((select id from public.categories order by slug limit 1),'NOPE',50,1);
reset role;

\echo '-- ACTIVE editor inserts item       [EXPECT: INSERT 0 1]'
select set_config('test.uid',:ACT,false);
set role authenticated;
insert into public.items(category_id,brand,price,stock_quantity)
  values ((select id from public.categories order by slug limit 1),'YES',50,1);
reset role;
