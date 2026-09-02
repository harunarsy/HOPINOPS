-- HOPIN role scopes: separate business title from application permissions.

alter type public.app_role add value if not exists 'INVESTOR';
alter type public.app_role add value if not exists 'OWNER';

alter table public.profiles
  add column if not exists username text,
  add column if not exists job_title text;

create unique index if not exists profiles_username_lower_idx
on public.profiles (lower(username))
where username is not null;

alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{1,30}$');

update public.profiles profile
set username = lower(regexp_replace(split_part(auth_user.email, '@', 1), '[^a-z0-9._-]+', '_', 'g'))
from auth.users auth_user
where auth_user.id = profile.id
  and profile.username is null
  and auth_user.email is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
begin
  requested_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', split_part(coalesce(new.email, 'operator'), '@', 1)),
    '[^a-z0-9._-]+',
    '_',
    'g'
  ));

  insert into public.profiles (id, username, display_name, job_title)
  values (
    new.id,
    nullif(requested_username, ''),
    upper(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), requested_username, 'OPERATOR')),
    coalesce(nullif(new.raw_user_meta_data ->> 'job_title', ''), 'STAFF')
  );
  return new;
end;
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active = true
      and role::text in ('SUPERVISOR', 'OWNER', 'ADMIN')
  );
$$;

create or replace function public.can_view_finance()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and active = true
      and role::text in ('INVESTOR', 'OWNER', 'ADMIN')
  );
$$;

create or replace function public.get_login_options()
returns table (username text, display_name text, job_title text)
language sql
stable
security definer
set search_path = public
as $$
  select profile.username, profile.display_name, profile.job_title
  from public.profiles profile
  where profile.active = true
    and profile.username is not null
  order by profile.display_name;
$$;

grant execute on function public.get_login_options() to anon, authenticated;
