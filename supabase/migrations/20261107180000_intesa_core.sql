-- Intesa core schema: a person's own map (people, ties), what they remember (notes),
-- what they owe (lists, todos), and who changed what (activity).
-- Every row belongs to one owner; Row Level Security keeps it theirs. Agents act as the
-- owner through OAuth, and their client id is recorded on every write they make.

create extension if not exists pgcrypto;

-- ───────────────────────── who is acting ─────────────────────────
-- 'you' for the app and ordinary sessions; the OAuth client id for an agent.
create or replace function public.actor() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id', 'you');
$$;

-- A readable name for an actor, when Auth knows the client.
create or replace function public.actor_name(cid text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare n text;
begin
  if cid is null or cid = 'you' then return 'you'; end if;
  begin
    execute 'select client_name from auth.oauth_clients where id = $1::uuid' into n using cid;
  exception when others then n := null;
  end;
  return coalesce(n, cid);
end $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;

-- ───────────────────────── profile: the centre of the map ─────────────────────────
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  title text not null default '',
  company text not null default '',
  school text not null default '',
  city text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "own profile" on public.profiles for all
  using (id = auth.uid()) with check (id = auth.uid());
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  insert into public.lists (owner_id, name, position) values (new.id, 'Follow-ups', 0) on conflict do nothing;
  return new;
end $$;

-- ───────────────────────── people ─────────────────────────
create table public.people (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  title text not null default '',
  company text not null default '',
  school text not null default '',
  city text not null default '',
  tags text[] not null default '{}',
  ring smallint not null default 1 check (ring between 1 and 3),
  work_email text not null default '',
  personal_email text not null default '',
  phone text not null default '',
  linkedin text not null default '',
  facebook text not null default '',
  instagram text not null default '',
  x_handle text not null default '',
  met_where text not null default '',
  met_when text not null default '',
  sources text[] not null default '{}',
  created_by text not null default public.actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index people_owner_idx on public.people (owner_id);
create index people_owner_name_idx on public.people (owner_id, lower(name));
alter table public.people enable row level security;
create policy "own people" on public.people for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create trigger people_touch before update on public.people
  for each row execute function public.touch_updated_at();

-- ───────────────────────── ties ─────────────────────────
-- a_id null means the owner themself. Pairs are stored with a_id < b_id so each tie exists once.
create table public.ties (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  a_id uuid references public.people(id) on delete cascade,
  b_id uuid not null references public.people(id) on delete cascade,
  kind text not null default '',
  created_by text not null default public.actor(),
  created_at timestamptz not null default now(),
  check (a_id is null or a_id <> b_id)
);
create unique index ties_pair_idx on public.ties (owner_id, coalesce(a_id, '00000000-0000-0000-0000-000000000000'::uuid), b_id);
create index ties_owner_idx on public.ties (owner_id);
alter table public.ties enable row level security;
create policy "own ties" on public.ties for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create or replace function public.tie_normalize() returns trigger
language plpgsql set search_path = '' as $$
declare t uuid;
begin
  if new.a_id is not null and new.a_id > new.b_id then t := new.a_id; new.a_id := new.b_id; new.b_id := t; end if;
  return new;
end $$;
create trigger ties_normalize before insert or update on public.ties
  for each row execute function public.tie_normalize();

-- ───────────────────────── lists and to-dos ─────────────────────────
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_by text not null default public.actor(),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);
alter table public.lists enable row level security;
create policy "own lists" on public.lists for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create table public.todos (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  list_id uuid references public.lists(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,
  title text not null,
  due_on date,
  done_at timestamptz,
  created_by text not null default public.actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index todos_owner_open_idx on public.todos (owner_id, due_on) where done_at is null;
create index todos_person_idx on public.todos (person_id);
alter table public.todos enable row level security;
create policy "own todos" on public.todos for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create trigger todos_touch before update on public.todos
  for each row execute function public.touch_updated_at();

-- ───────────────────────── notes ─────────────────────────
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  person_id uuid references public.people(id) on delete cascade,
  kind text not null default 'Other',
  body text not null,
  happened_on date not null default current_date,
  created_by text not null default public.actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_owner_idx on public.notes (owner_id, created_at desc);
create index notes_person_idx on public.notes (person_id);
alter table public.notes enable row level security;
create policy "own notes" on public.notes for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();

-- ───────────────────────── activity: who changed what ─────────────────────────
create table public.activity (
  id bigserial primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor text not null,
  action text not null,
  entity text not null,
  entity_id uuid,
  summary text not null default '',
  at timestamptz not null default now()
);
create index activity_owner_idx on public.activity (owner_id, at desc);
alter table public.activity enable row level security;
create policy "read own activity" on public.activity for select using (owner_id = auth.uid());

create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb; s text;
begin
  r := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  s := coalesce(r->>'name', r->>'title', left(r->>'body', 80), '');
  insert into public.activity (owner_id, actor, action, entity, entity_id, summary)
  values ((r->>'owner_id')::uuid, public.actor(), lower(tg_op), tg_table_name, (r->>'id')::uuid, s);
  return coalesce(new, old);
end $$;
create trigger people_log after insert or update or delete on public.people for each row execute function public.log_activity();
create trigger ties_log   after insert or delete           on public.ties   for each row execute function public.log_activity();
create trigger notes_log  after insert or update or delete on public.notes  for each row execute function public.log_activity();
create trigger todos_log  after insert or update or delete on public.todos  for each row execute function public.log_activity();
create trigger lists_log  after insert or delete           on public.lists  for each row execute function public.log_activity();

-- ───────────────────────── derived: when did you last touch someone ─────────────────────────
create or replace view public.people_touch with (security_invoker = true) as
select p.id, p.owner_id, p.name, p.ring,
  greatest(p.updated_at,
    coalesce((select max(n.created_at) from public.notes n where n.person_id = p.id), p.created_at),
    coalesce((select max(t.updated_at) from public.todos t where t.person_id = p.id), p.created_at)) as last_touch,
  (select count(*) from public.todos t where t.person_id = p.id and t.done_at is null) as open_todos
from public.people p;

-- ───────────────────────── new users ─────────────────────────
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── live updates to the open app ─────────────────────────
alter publication supabase_realtime add table public.people, public.ties, public.notes, public.todos, public.lists;
