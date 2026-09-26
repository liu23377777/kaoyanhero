-- 考研勇者多人版数据库结构
-- 在 Supabase Dashboard > SQL Editor 中完整执行一次。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  xp integer not null default 0 check (xp >= 0),
  coin integer not null default 0 check (coin >= 0),
  streak integer not null default 0 check (streak >= 0),
  last_date date,
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  approval_comment text not null default '',
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 兼容已经上线、仅含 approved 布尔字段的旧数据库。
-- 新增字段时先保持 nullable，完成旧数据迁移后再加默认值和非空约束，脚本可重复执行。
alter table public.profiles add column if not exists approval_status text;
alter table public.profiles add column if not exists approval_comment text;
alter table public.profiles add column if not exists reviewed_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'approved'
  ) then
    execute $migration$
      update public.profiles
      set approval_status = case when approved is true then 'approved' else 'pending' end
      where approval_status is null
    $migration$;
  else
    update public.profiles set approval_status = 'pending' where approval_status is null;
  end if;
end;
$$;

update public.profiles set approval_comment = '' where approval_comment is null;
alter table public.profiles alter column approval_status set default 'pending';
alter table public.profiles alter column approval_status set not null;
alter table public.profiles alter column approval_comment set default '';
alter table public.profiles alter column approval_comment set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_approval_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_approval_status_check
      check (approval_status in ('pending', 'approved', 'rejected'));
  end if;
end;
$$;

create table if not exists public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  study_text text not null default '',
  topics jsonb not null default '[]'::jsonb,
  photo_count integer not null default 0 check (photo_count between 0 and 6),
  score integer not null check (score between 0 and 100),
  title text not null,
  review jsonb not null,
  provider text not null,
  model text not null,
  xp integer not null default 0 check (xp >= 0),
  coin integer not null default 0 check (coin >= 0),
  ai_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists checkins_user_created_idx on public.checkins(user_id, created_at desc);

create table if not exists public.study_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 30),
  invite_code text not null unique check (invite_code ~ '^[A-Z0-9]{8}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.study_team_members (
  team_id uuid not null references public.study_teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 20),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id),
  unique (user_id)
);

create index if not exists study_team_members_team_joined_idx
  on public.study_team_members(team_id, joined_at);

create table if not exists public.reward_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reward_group_members (
  group_id uuid not null references public.reward_groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.reward_catalog (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 60),
  description text not null default '' check (char_length(description) <= 500),
  coin_cost integer not null default 0 check (coin_cost >= 0),
  stock integer check (stock is null or stock >= 0),
  per_user_limit integer not null default 1 check (per_user_limit between 1 and 999),
  audience_mode text not null default 'all' check (audience_mode in ('all', 'users', 'group')),
  target_user_ids uuid[] not null default '{}'::uuid[],
  group_id uuid references public.reward_groups(id) on delete set null,
  requires_review boolean not null default false,
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table if not exists public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  reward_id uuid not null references public.reward_catalog(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  coin_cost integer not null check (coin_cost >= 0),
  status text not null default 'fulfilled' check (status in ('pending', 'fulfilled', 'rejected', 'cancelled')),
  review_note text not null default '' check (char_length(review_note) <= 500),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- 兼容已经上线的奖励表：老兑换视为已自动发放。
alter table public.reward_catalog add column if not exists requires_review boolean not null default false;
alter table public.reward_redemptions add column if not exists review_note text not null default '';
alter table public.reward_redemptions add column if not exists reviewed_at timestamptz;
update public.reward_redemptions set status = 'fulfilled' where status = 'redeemed';
alter table public.reward_redemptions alter column status set default 'fulfilled';
alter table public.reward_redemptions drop constraint if exists reward_redemptions_status_check;
alter table public.reward_redemptions add constraint reward_redemptions_status_check
  check (status in ('pending', 'fulfilled', 'rejected', 'cancelled'));

create index if not exists reward_redemptions_reward_user_idx
  on public.reward_redemptions(reward_id, user_id, created_at desc);
create index if not exists reward_group_members_user_idx
  on public.reward_group_members(user_id, group_id);

create table if not exists public.ai_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'glm',
  reasoning_mode text not null default 'balanced' check (reasoning_mode in ('fast', 'balanced', 'deep')),
  detail_level text not null default 'standard' check (detail_level in ('concise', 'standard', 'detailed')),
  max_tokens integer not null default 8192 check (max_tokens between 2048 and 12000),
  temperature numeric(3,2) not null default 0.35 check (temperature between 0 and 1),
  updated_at timestamptz not null default now()
);

create table if not exists public.habitica_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  habitica_user_id text not null,
  token_ciphertext text not null,
  task_id text not null,
  client_id text not null,
  task_name text not null default '考研勇者每日打卡',
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default current_date,
  ai_requests integer not null default 0 check (ai_requests >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

alter table public.profiles enable row level security;
alter table public.checkins enable row level security;
alter table public.study_teams enable row level security;
alter table public.study_team_members enable row level security;
alter table public.reward_groups enable row level security;
alter table public.reward_group_members enable row level security;
alter table public.reward_catalog enable row level security;
alter table public.reward_redemptions enable row level security;
alter table public.ai_preferences enable row level security;
alter table public.habitica_connections enable row level security;
alter table public.usage_counters enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);

drop policy if exists "checkins_select_own" on public.checkins;
create policy "checkins_select_own" on public.checkins for select using (auth.uid() = user_id);

drop policy if exists "preferences_select_own" on public.ai_preferences;
create policy "preferences_select_own" on public.ai_preferences for select using (auth.uid() = user_id);
drop policy if exists "preferences_insert_own" on public.ai_preferences;
create policy "preferences_insert_own" on public.ai_preferences for insert with check (auth.uid() = user_id);
drop policy if exists "preferences_update_own" on public.ai_preferences;
create policy "preferences_update_own" on public.ai_preferences for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "habitica_select_own" on public.habitica_connections;
create policy "habitica_select_own" on public.habitica_connections for select using (auth.uid() = user_id);
drop policy if exists "habitica_insert_own" on public.habitica_connections;
create policy "habitica_insert_own" on public.habitica_connections for insert with check (auth.uid() = user_id);
drop policy if exists "habitica_update_own" on public.habitica_connections;
create policy "habitica_update_own" on public.habitica_connections for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "usage_select_own" on public.usage_counters;
create policy "usage_select_own" on public.usage_counters for select using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles(id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.record_checkin(
  p_text text,
  p_topics jsonb,
  p_photo_count integer,
  p_review jsonb,
  p_provider text,
  p_model text,
  p_xp integer,
  p_coin integer,
  p_ai_options jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_streak integer;
  v_checkin public.checkins%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_xp < 0 or p_coin < 0 then raise exception 'Invalid rewards'; end if;

  insert into public.profiles(id) values (v_user) on conflict (id) do nothing;
  select * into v_profile from public.profiles where id = v_user for update;

  if v_profile.approval_status = 'rejected' then
    raise exception 'ACCOUNT_REJECTED';
  elsif v_profile.approval_status <> 'approved' then
    raise exception 'ACCOUNT_PENDING_APPROVAL';
  end if;

  if v_profile.last_date = current_date then
    v_streak := v_profile.streak;
  elsif v_profile.last_date = current_date - 1 then
    v_streak := v_profile.streak + 1;
  else
    v_streak := 1;
  end if;

  insert into public.checkins(user_id, study_text, topics, photo_count, score, title, review, provider, model, xp, coin, ai_options)
  values (
    v_user,
    left(coalesce(p_text, ''), 4000),
    coalesce(p_topics, '[]'::jsonb),
    greatest(0, least(6, p_photo_count)),
    greatest(0, least(100, coalesce((p_review->>'score')::integer, 60))),
    left(coalesce(p_review->>'title', '学习打卡'), 80),
    p_review,
    left(p_provider, 100),
    left(p_model, 120),
    p_xp,
    p_coin,
    coalesce(p_ai_options, '{}'::jsonb)
  ) returning * into v_checkin;

  update public.profiles
    set xp = xp + p_xp,
        coin = coin + p_coin,
        streak = v_streak,
        last_date = current_date,
        updated_at = now()
    where id = v_user
    returning * into v_profile;

  return jsonb_build_object(
    'profile', jsonb_build_object('xp', v_profile.xp, 'coin', v_profile.coin, 'streak', v_profile.streak, 'lastDate', v_profile.last_date),
    'checkin', jsonb_build_object('id', v_checkin.id, 'score', v_checkin.score, 'title', v_checkin.title, 'provider', v_checkin.provider, 'xp', v_checkin.xp, 'createdAt', v_checkin.created_at)
  );
end;
$$;

create or replace function public.consume_ai_quota(p_limit integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count integer;
  v_approval_status text;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_limit < 1 or p_limit > 1000 then raise exception 'Invalid quota limit'; end if;

  insert into public.profiles(id) values (v_user) on conflict (id) do nothing;
  select approval_status into v_approval_status from public.profiles where id = v_user;
  if v_approval_status = 'rejected' then
    raise exception 'ACCOUNT_REJECTED';
  elsif v_approval_status <> 'approved' then
    raise exception 'ACCOUNT_PENDING_APPROVAL';
  end if;

  insert into public.usage_counters(user_id, usage_date, ai_requests)
  values (v_user, current_date, 1)
  on conflict (user_id, usage_date)
  do update set ai_requests = public.usage_counters.ai_requests + 1, updated_at = now()
  returning ai_requests into v_count;

  if v_count > p_limit then
    raise exception 'DAILY_AI_LIMIT_REACHED';
  end if;
  return v_count;
end;
$$;

-- 服务端专用版本：奖励数值只能由受信任的应用服务写入，避免客户端直接调用 RPC 刷金币。
create or replace function public.record_checkin_server(
  p_user_id uuid,
  p_text text,
  p_topics jsonb,
  p_photo_count integer,
  p_review jsonb,
  p_provider text,
  p_model text,
  p_xp integer,
  p_coin integer,
  p_ai_options jsonb
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := p_user_id;
  v_profile public.profiles%rowtype;
  v_streak integer;
  v_checkin public.checkins%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if v_user is null then raise exception 'User required'; end if;
  if p_xp < 0 or p_xp > 220 or p_coin < 0 or p_coin > 50 then raise exception 'Invalid rewards'; end if;

  insert into public.profiles(id) values (v_user) on conflict (id) do nothing;
  select * into v_profile from public.profiles where id = v_user for update;
  if v_profile.approval_status = 'rejected' then
    raise exception 'ACCOUNT_REJECTED';
  elsif v_profile.approval_status <> 'approved' then
    raise exception 'ACCOUNT_PENDING_APPROVAL';
  end if;

  if v_profile.last_date = current_date then
    v_streak := v_profile.streak;
  elsif v_profile.last_date = current_date - 1 then
    v_streak := v_profile.streak + 1;
  else
    v_streak := 1;
  end if;

  insert into public.checkins(user_id, study_text, topics, photo_count, score, title, review, provider, model, xp, coin, ai_options)
  values (
    v_user, left(coalesce(p_text, ''), 4000), coalesce(p_topics, '[]'::jsonb),
    greatest(0, least(6, p_photo_count)),
    greatest(0, least(100, coalesce((p_review->>'score')::integer, 60))),
    left(coalesce(p_review->>'title', '学习打卡'), 80), p_review,
    left(p_provider, 100), left(p_model, 120), p_xp, p_coin, coalesce(p_ai_options, '{}'::jsonb)
  ) returning * into v_checkin;

  update public.profiles
    set xp = xp + p_xp, coin = coin + p_coin, streak = v_streak,
        last_date = current_date, updated_at = now()
    where id = v_user returning * into v_profile;

  return jsonb_build_object(
    'profile', jsonb_build_object('xp', v_profile.xp, 'coin', v_profile.coin, 'streak', v_profile.streak, 'lastDate', v_profile.last_date),
    'checkin', jsonb_build_object('id', v_checkin.id, 'score', v_checkin.score, 'title', v_checkin.title, 'provider', v_checkin.provider, 'xp', v_checkin.xp, 'coin', v_checkin.coin, 'createdAt', v_checkin.created_at)
  );
end;
$$;

create or replace function public.assert_team_user_approved()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_status text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select approval_status into v_status from public.profiles where id = auth.uid();
  if v_status <> 'approved' then raise exception 'ACCOUNT_NOT_APPROVED'; end if;
end;
$$;

create or replace function public.create_study_team(p_name text, p_nickname text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team public.study_teams%rowtype;
  v_code text;
  v_attempt integer := 0;
begin
  perform public.assert_team_user_approved();
  if exists (select 1 from public.study_team_members where user_id = v_user) then
    raise exception 'ALREADY_IN_TEAM';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 30 then raise exception 'INVALID_TEAM_NAME'; end if;
  if char_length(trim(coalesce(p_nickname, ''))) not between 1 and 20 then raise exception 'INVALID_NICKNAME'; end if;

  loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 8));
    exit when not exists (select 1 from public.study_teams where invite_code = v_code);
    v_attempt := v_attempt + 1;
    if v_attempt >= 10 then raise exception 'INVITE_CODE_GENERATION_FAILED'; end if;
  end loop;

  insert into public.study_teams(name, invite_code, owner_id)
  values (trim(p_name), v_code, v_user)
  returning * into v_team;

  insert into public.study_team_members(team_id, user_id, nickname, role)
  values (v_team.id, v_user, trim(p_nickname), 'owner');

  return jsonb_build_object('id', v_team.id, 'name', v_team.name, 'inviteCode', v_team.invite_code);
end;
$$;

create or replace function public.join_study_team(p_invite_code text, p_nickname text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team public.study_teams%rowtype;
begin
  perform public.assert_team_user_approved();
  if exists (select 1 from public.study_team_members where user_id = v_user) then
    raise exception 'ALREADY_IN_TEAM';
  end if;
  if char_length(trim(coalesce(p_nickname, ''))) not between 1 and 20 then raise exception 'INVALID_NICKNAME'; end if;

  select * into v_team
  from public.study_teams
  where invite_code = upper(trim(coalesce(p_invite_code, '')))
  for update;
  if not found then raise exception 'TEAM_NOT_FOUND'; end if;
  if (select count(*) from public.study_team_members where team_id = v_team.id) >= 12 then
    raise exception 'TEAM_FULL';
  end if;

  insert into public.study_team_members(team_id, user_id, nickname, role)
  values (v_team.id, v_user, trim(p_nickname), 'member');
  return jsonb_build_object('id', v_team.id, 'name', v_team.name);
end;
$$;

create or replace function public.get_my_study_team()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team_id uuid;
  v_result jsonb;
begin
  perform public.assert_team_user_approved();
  select team_id into v_team_id from public.study_team_members where user_id = v_user;
  if v_team_id is null then return null; end if;

  select jsonb_build_object(
    'id', t.id,
    'name', t.name,
    'inviteCode', t.invite_code,
    'ownerId', t.owner_id,
    'currentUserId', v_user,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', m.user_id,
        'nickname', m.nickname,
        'role', m.role,
        'joinedAt', m.joined_at,
        'xp', coalesce(p.xp, 0),
        'streak', coalesce(p.streak, 0),
        'lastDate', p.last_date,
        'checkinCount', (select count(*) from public.checkins c where c.user_id = m.user_id)
      ) order by case when m.role = 'owner' then 0 else 1 end, m.joined_at)
      from public.study_team_members m
      left join public.profiles p on p.id = m.user_id
      where m.team_id = t.id
    ), '[]'::jsonb)
  ) into v_result
  from public.study_teams t
  where t.id = v_team_id;
  return v_result;
end;
$$;

create or replace function public.get_study_team_checkins(p_user_id uuid, p_limit integer default 20)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_own_team uuid;
  v_target_team uuid;
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_result jsonb;
begin
  perform public.assert_team_user_approved();
  select team_id into v_own_team from public.study_team_members where user_id = v_user;
  select team_id into v_target_team from public.study_team_members where user_id = p_user_id;
  if v_own_team is null or v_target_team is null or v_own_team <> v_target_team then
    raise exception 'TEAM_ACCESS_DENIED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', recent.id,
    'studyText', recent.study_text,
    'topics', recent.topics,
    'photoCount', recent.photo_count,
    'score', recent.score,
    'title', recent.title,
    'review', recent.review,
    'provider', recent.provider,
    'xp', recent.xp,
    'createdAt', recent.created_at
  ) order by recent.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select c.* from public.checkins c
    where c.user_id = p_user_id
    order by c.created_at desc
    limit v_limit
  ) recent;
  return v_result;
end;
$$;

create or replace function public.leave_study_team()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_member public.study_team_members%rowtype;
  v_next_owner uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_member from public.study_team_members where user_id = v_user for update;
  if not found then raise exception 'NOT_IN_TEAM'; end if;

  if v_member.role = 'owner' then
    select user_id into v_next_owner
    from public.study_team_members
    where team_id = v_member.team_id and user_id <> v_user
    order by joined_at
    limit 1;
    if v_next_owner is null then
      delete from public.study_teams where id = v_member.team_id;
      return jsonb_build_object('disbanded', true);
    end if;
    update public.study_teams set owner_id = v_next_owner, updated_at = now() where id = v_member.team_id;
    update public.study_team_members set role = 'owner' where team_id = v_member.team_id and user_id = v_next_owner;
  end if;

  delete from public.study_team_members where team_id = v_member.team_id and user_id = v_user;
  return jsonb_build_object('disbanded', false, 'newOwnerId', v_next_owner);
end;
$$;

create or replace function public.get_available_rewards()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_coin integer;
  v_status text;
  v_rewards jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select coin, approval_status into v_coin, v_status from public.profiles where id = v_user;
  if v_status <> 'approved' then raise exception 'ACCOUNT_NOT_APPROVED'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', visible.id,
    'title', visible.title,
    'description', visible.description,
    'coinCost', visible.coin_cost,
    'stock', visible.stock,
    'redeemedTotal', visible.redeemed_total,
    'remainingStock', case when visible.stock is null then null else greatest(0, visible.stock - visible.redeemed_total) end,
    'perUserLimit', visible.per_user_limit,
    'redeemedByMe', visible.redeemed_by_me,
    'remainingForMe', greatest(0, visible.per_user_limit - visible.redeemed_by_me),
    'audienceMode', visible.audience_mode,
    'groupName', visible.group_name,
    'requiresReview', visible.requires_review,
    'latestStatus', visible.latest_status,
    'canRedeem', v_coin >= visible.coin_cost
      and visible.redeemed_by_me < visible.per_user_limit
      and (visible.stock is null or visible.redeemed_total < visible.stock),
    'createdAt', visible.created_at
  ) order by visible.created_at desc), '[]'::jsonb)
  into v_rewards
  from (
    select r.*,
      g.name as group_name,
      (select count(*)::integer from public.reward_redemptions rr where rr.reward_id = r.id and rr.status not in ('cancelled', 'rejected')) as redeemed_total,
      (select count(*)::integer from public.reward_redemptions rr where rr.reward_id = r.id and rr.user_id = v_user and rr.status not in ('cancelled', 'rejected')) as redeemed_by_me,
      (select rr.status from public.reward_redemptions rr where rr.reward_id = r.id and rr.user_id = v_user order by rr.created_at desc limit 1) as latest_status
    from public.reward_catalog r
    left join public.reward_groups g on g.id = r.group_id
    where r.active is true
      and (r.starts_at is null or r.starts_at <= now())
      and (r.ends_at is null or r.ends_at > now())
      and (
        r.audience_mode = 'all'
        or (r.audience_mode = 'users' and v_user = any(r.target_user_ids))
        or (r.audience_mode = 'group' and exists (
          select 1 from public.reward_group_members gm where gm.group_id = r.group_id and gm.user_id = v_user
        ))
      )
  ) visible;

  return jsonb_build_object('coin', coalesce(v_coin, 0), 'rewards', v_rewards);
end;
$$;

create or replace function public.redeem_reward(p_reward_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_reward public.reward_catalog%rowtype;
  v_profile public.profiles%rowtype;
  v_user_count integer;
  v_total_count integer;
  v_redemption public.reward_redemptions%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_reward from public.reward_catalog where id = p_reward_id for update;
  if not found then raise exception 'REWARD_NOT_FOUND'; end if;
  if not v_reward.active or (v_reward.starts_at is not null and v_reward.starts_at > now())
    or (v_reward.ends_at is not null and v_reward.ends_at <= now()) then
    raise exception 'REWARD_UNAVAILABLE';
  end if;
  if v_reward.audience_mode = 'users' and not (v_user = any(v_reward.target_user_ids)) then
    raise exception 'REWARD_NOT_FOR_USER';
  end if;
  if v_reward.audience_mode = 'group' and not exists (
    select 1 from public.reward_group_members where group_id = v_reward.group_id and user_id = v_user
  ) then
    raise exception 'REWARD_NOT_FOR_USER';
  end if;

  select * into v_profile from public.profiles where id = v_user for update;
  if v_profile.approval_status <> 'approved' then raise exception 'ACCOUNT_NOT_APPROVED'; end if;
  select count(*) into v_user_count from public.reward_redemptions
    where reward_id = v_reward.id and user_id = v_user and status not in ('cancelled', 'rejected');
  if v_user_count >= v_reward.per_user_limit then raise exception 'REWARD_LIMIT_REACHED'; end if;
  select count(*) into v_total_count from public.reward_redemptions
    where reward_id = v_reward.id and status not in ('cancelled', 'rejected');
  if v_reward.stock is not null and v_total_count >= v_reward.stock then raise exception 'REWARD_OUT_OF_STOCK'; end if;
  if v_profile.coin < v_reward.coin_cost then raise exception 'INSUFFICIENT_COINS'; end if;

  update public.profiles set coin = coin - v_reward.coin_cost, updated_at = now() where id = v_user
    returning * into v_profile;
  insert into public.reward_redemptions(reward_id, user_id, coin_cost, status)
    values (v_reward.id, v_user, v_reward.coin_cost, case when v_reward.requires_review then 'pending' else 'fulfilled' end)
    returning * into v_redemption;
  return jsonb_build_object(
    'redemptionId', v_redemption.id,
    'coin', v_profile.coin,
    'status', v_redemption.status,
    'requiresReview', v_reward.requires_review,
    'redeemedByMe', v_user_count + 1,
    'redeemedTotal', v_total_count + 1
  );
end;
$$;

create or replace function public.review_reward_redemption(
  p_redemption_id uuid,
  p_status text,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_redemption public.reward_redemptions%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'ADMIN_REQUIRED'; end if;
  if p_status not in ('fulfilled', 'rejected') then raise exception 'INVALID_REVIEW_STATUS'; end if;
  if p_status = 'rejected' and char_length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'REJECTION_NOTE_REQUIRED';
  end if;
  if char_length(trim(coalesce(p_note, ''))) > 500 then raise exception 'REVIEW_NOTE_TOO_LONG'; end if;

  select * into v_redemption from public.reward_redemptions
    where id = p_redemption_id for update;
  if not found then raise exception 'REDEMPTION_NOT_FOUND'; end if;
  if v_redemption.status <> 'pending' then raise exception 'REDEMPTION_ALREADY_REVIEWED'; end if;

  update public.reward_redemptions
    set status = p_status, review_note = trim(coalesce(p_note, '')), reviewed_at = now()
    where id = v_redemption.id;

  if p_status = 'rejected' then
    update public.profiles
      set coin = coin + v_redemption.coin_cost, updated_at = now()
      where id = v_redemption.user_id;
  end if;

  return jsonb_build_object(
    'id', v_redemption.id,
    'status', p_status,
    'refundedCoin', case when p_status = 'rejected' then v_redemption.coin_cost else 0 end,
    'reviewedAt', now()
  );
end;
$$;

revoke all on function public.record_checkin(text, jsonb, integer, jsonb, text, text, integer, integer, jsonb) from public;
revoke all on function public.record_checkin(text, jsonb, integer, jsonb, text, text, integer, integer, jsonb) from authenticated;
revoke all on function public.record_checkin_server(uuid, text, jsonb, integer, jsonb, text, text, integer, integer, jsonb) from public;
grant execute on function public.record_checkin_server(uuid, text, jsonb, integer, jsonb, text, text, integer, integer, jsonb) to service_role;
revoke all on function public.consume_ai_quota(integer) from public;
grant execute on function public.consume_ai_quota(integer) to authenticated;
revoke all on function public.assert_team_user_approved() from public;
revoke all on function public.create_study_team(text, text) from public;
revoke all on function public.join_study_team(text, text) from public;
revoke all on function public.get_my_study_team() from public;
revoke all on function public.get_study_team_checkins(uuid, integer) from public;
revoke all on function public.leave_study_team() from public;
revoke all on function public.get_available_rewards() from public;
revoke all on function public.redeem_reward(uuid) from public;
revoke all on function public.review_reward_redemption(uuid, text, text) from public;
grant execute on function public.create_study_team(text, text) to authenticated;
grant execute on function public.join_study_team(text, text) to authenticated;
grant execute on function public.get_my_study_team() to authenticated;
grant execute on function public.get_study_team_checkins(uuid, integer) to authenticated;
grant execute on function public.leave_study_team() to authenticated;
grant execute on function public.get_available_rewards() to authenticated;
grant execute on function public.redeem_reward(uuid) to authenticated;
grant execute on function public.review_reward_redemption(uuid, text, text) to service_role;

grant usage on schema public to authenticated;
grant select on public.profiles, public.checkins to authenticated;
grant select, insert, update on public.ai_preferences, public.habitica_connections to authenticated;
grant select on public.usage_counters to authenticated;

notify pgrst, 'reload schema';
