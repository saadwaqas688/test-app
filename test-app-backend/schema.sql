-- Run in Supabase: SQL Editor -> paste -> Run. Safe to re-run.
create extension if not exists pgcrypto;

create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  username   text unique not null,
  pass_hash  text not null,
  pass_salt  text not null,
  role       text not null default 'user',
  created_at timestamptz default now()
);

create table if not exists devices (
  id            text primary key,
  user_id       uuid,
  label         text,
  last_seen     timestamptz,
  running       boolean default false,
  today_seconds integer default 0
);

create table if not exists daily_stats (
  device_id  text,
  user_id    uuid,
  day        date not null,
  seconds    integer default 0,
  deleted    integer default 0,
  active_pct integer default 0,
  primary key (device_id, day)
);

create table if not exists app_usage (
  device_id  text,
  user_id    uuid,
  app        text not null,
  seconds    integer default 0,
  updated_at timestamptz default now(),
  primary key (device_id, app)
);

create table if not exists site_visits (
  id        bigint generated always as identity primary key,
  device_id text,
  user_id   uuid,
  ts        timestamptz not null,
  domain    text, title text, url text, browser text,
  unique (device_id, ts, url)
);

-- migrations for older installs (add user scoping)
alter table devices     add column if not exists user_id uuid;
alter table daily_stats add column if not exists user_id uuid;
alter table app_usage   add column if not exists user_id uuid;
alter table site_visits add column if not exists user_id uuid;

create index if not exists idx_devices_user on devices(user_id);
create index if not exists idx_daily_user   on daily_stats(user_id, day desc);
create index if not exists idx_apps_user    on app_usage(user_id);
create index if not exists idx_visits_user  on site_visits(user_id, ts desc);
