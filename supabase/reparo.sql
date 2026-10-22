-- ===========================================================================
-- REPARO — acerta a estrutura sem apagar nada
--
-- Use quando aparecer erro como:
--   PGRST204  Could not find the 'atualizado_em' column of 'perfis'
--
-- Cole inteiro em: Supabase → SQL Editor → New query → Run.
-- Pode rodar quantas vezes quiser.
-- ===========================================================================

-- 1) Cria as tabelas se não existirem (mesma estrutura do schema.sql)
create table if not exists public.perfis (
  id            uuid primary key,
  nome          text not null,
  cor           text not null default '#6ee7ff',
  dados         jsonb not null default '{}'::jsonb,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

create table if not exists public.dados (
  id            text primary key,
  conteudo      jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.backups (
  id        bigserial primary key,
  conteudo  jsonb not null,
  criado_em timestamptz not null default now()
);

-- 2) Completa colunas que podem faltar em tabelas criadas antes/à mão
alter table public.perfis  add column if not exists nome          text;
alter table public.perfis  add column if not exists cor           text default '#6ee7ff';
alter table public.perfis  add column if not exists dados         jsonb default '{}'::jsonb;
alter table public.perfis  add column if not exists criado_em     timestamptz default now();
alter table public.perfis  add column if not exists atualizado_em timestamptz default now();

alter table public.dados   add column if not exists conteudo      jsonb default '{}'::jsonb;
alter table public.dados   add column if not exists atualizado_em timestamptz default now();

alter table public.backups add column if not exists conteudo      jsonb;
alter table public.backups add column if not exists criado_em     timestamptz default now();

-- 3) Índices (ignora se já existem)
create index if not exists perfis_criado_em_idx  on public.perfis (criado_em);
create index if not exists backups_criado_em_idx on public.backups (criado_em desc);

-- 4) Segurança: RLS ligado e sem políticas (a chave pública não acessa;
--    a service_role usada no servidor ignora o RLS)
alter table public.perfis  enable row level security;
alter table public.dados   enable row level security;
alter table public.backups enable row level security;

-- 5) Faz a API REST enxergar a estrutura nova na hora (evita esperar)
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Conferência: deve listar as colunas das três tabelas
-- ---------------------------------------------------------------------------
select table_name, column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('perfis', 'dados', 'backups')
 order by table_name, ordinal_position;
