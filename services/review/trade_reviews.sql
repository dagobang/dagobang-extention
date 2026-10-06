-- Run once in the Supabase SQL editor.
-- The extension uses the anon key with no user login, so this table is readable
-- by anyone who has that key.

create table if not exists public.trade_reviews (
  id text primary key,
  wallet_address text not null default '',
  chain text not null default '',
  token_address text not null default '',
  token_symbol text not null default '',
  token_name text not null default '',
  launchpad text not null default '',
  visibility text not null default 'private',
  review_title text not null default '',
  tags text[] not null default '{}',
  narrative_tags text[] not null default '{}',
  mistakes text[] not null default '{}',
  buy_logic text not null default '',
  sell_logic text not null default '',
  emotion_score integer not null default 0,
  execution_score integer not null default 0,
  confidence_score integer not null default 0,
  quality_score integer not null default 0,
  likes_count integer not null default 0,
  favorites_count integer not null default 0,
  comments_count integer not null default 0,
  engagement_score integer not null default 0,
  plan_take_profit text not null default '',
  plan_stop_loss text not null default '',
  summary text not null default '',
  lesson_learned text not null default '',
  next_action text not null default '',
  hold_start_at bigint,
  hold_end_at bigint,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists trade_reviews_wallet_updated_idx
  on public.trade_reviews (wallet_address, updated_at desc);

alter table public.trade_reviews enable row level security;

drop policy if exists trade_reviews_anon_all on public.trade_reviews;
create policy trade_reviews_anon_all
  on public.trade_reviews
  for all
  to anon, authenticated
  using (true)
  with check (true);
