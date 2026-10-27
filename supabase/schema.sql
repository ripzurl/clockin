-- Run this once in Supabase: SQL Editor > New query > paste > Run

-- 1. Profiles (one per signed-up user) -------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'employee' check (role in ('employee', 'manager')),
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Time entries -----------------------------------------------------------
create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  in_lat double precision,
  in_lng double precision,
  out_lat double precision,
  out_lng double precision,
  note text,
  duration_minutes integer generated always as (
    case when clock_out is not null
      then floor(extract(epoch from (clock_out - clock_in)) / 60)::int
    end
  ) stored,
  check (clock_out is null or clock_out > clock_in)
);

-- An employee can only have ONE open (not yet clocked-out) entry.
create unique index one_open_entry_per_employee
  on public.time_entries (employee_id)
  where clock_out is null;

create index time_entries_employee_clock_in
  on public.time_entries (employee_id, clock_in desc);

-- 3. Row level security -----------------------------------------------------
-- Employees can read their own rows. All writes go through the Netlify
-- Functions (service role), which enforce the clock-in/out rules.
alter table public.profiles enable row level security;
alter table public.time_entries enable row level security;

create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "read own entries" on public.time_entries
  for select using (auth.uid() = employee_id);

-- 4. Make yourself a manager (edit the email, then run) ---------------------
-- update public.profiles set role = 'manager'
-- where id = (select id from auth.users where email = 'you@example.com');
