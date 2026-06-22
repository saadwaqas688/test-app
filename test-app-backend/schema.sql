-- Run this in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.

create table if not exists devices (
  id           text primary key,
  label        text,
  last_seen    timestamptz,
  running      boolean default false,
  today_seconds integer default 0
);

create table if not exists daily_stats (
  device_id   text references devices(id) on delete cascade,
  day         date not null,
  seconds     integer default 0,
  deleted     integer default 0,
  active_pct  integer default 0,
  primary key (device_id, day)
);

create table if not exists app_usage (
  device_id   text references devices(id) on delete cascade,
  app         text not null,
  seconds     integer default 0,
  updated_at  timestamptz default now(),
  primary key (device_id, app)
);

create table if not exists site_visits (
  id          bigint generated always as identity primary key,
  device_id   text references devices(id) on delete cascade,
  ts          timestamptz not null,
  domain      text,
  title       text,
  url         text,
  browser     text,
  unique (device_id, ts, url)
);

create index if not exists idx_visits_device_ts on site_visits (device_id, ts desc);
create index if not exists idx_daily_device_day on daily_stats (device_id, day desc);
