\set MGR    '''22222222-2222-2222-2222-222222222222'''
\set EDITOR '''33333333-3333-3333-3333-333333333333'''

delete from public.client_errors; delete from public.profiles; delete from auth.users;
insert into auth.users(id,email) values (:MGR,'m@t'),(:EDITOR,'e@t');
update public.profiles set can_manage_users=true where id=:MGR;
update public.profiles set can_edit=true, can_manage_users=false where id=:EDITOR;

\echo '-- editor inserts a report, spoofing user_id=MANAGER'
select set_config('test.uid',:EDITOR,false);
set role authenticated;
insert into public.client_errors(context,message,user_id) values ('t','boom',:MGR::uuid);
\echo '-- editor reads client_errors                 [EXPECT: 0]'
select count(*) as editor_sees from public.client_errors;
\echo '-- editor UPDATE client_errors                [EXPECT: ERROR permission denied]'
update public.client_errors set message='x';
reset role;

\echo '-- stored user_id                             [EXPECT: editor 3333..., NOT manager 2222...]'
select user_id from public.client_errors order by id desc limit 1;

\echo '-- manager reads client_errors                [EXPECT: 1]'
select set_config('test.uid',:MGR,false);
set role authenticated;
select count(*) as manager_sees from public.client_errors;
reset role;
