-- ===========================================================================
-- Curso de Digitação JEV — estrutura do banco no Supabase
-- Cole este arquivo inteiro em: Supabase → SQL Editor → New query → Run.
-- Pode rodar mais de uma vez: usa "if not exists".
-- ===========================================================================

-- Um registro por pessoa (o progresso inteiro fica no jsonb "dados")
create table if not exists public.perfis (
  id            uuid primary key,
  nome          text not null,
  cor           text not null default '#6ee7ff',
  dados         jsonb not null default '{}'::jsonb,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Uma única linha (id = 'principal') com lições, etapas e pontuação
create table if not exists public.dados (
  id            text primary key,
  conteudo      jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);

-- Backups automáticos (guardamos os 20 mais recentes)
create table if not exists public.backups (
  id        bigserial primary key,
  conteudo  jsonb not null,
  criado_em timestamptz not null default now()
);

-- Índices úteis
create index if not exists perfis_criado_em_idx on public.perfis (criado_em);
create index if not exists backups_criado_em_idx on public.backups (criado_em desc);

-- ---------------------------------------------------------------------------
-- Completa colunas que podem faltar se a tabela foi criada antes ou à mão.
-- (É isso que causa o erro PGRST204 "Could not find the 'atualizado_em' column")
-- ---------------------------------------------------------------------------
alter table public.perfis  add column if not exists nome          text;
alter table public.perfis  add column if not exists cor           text default '#6ee7ff';
alter table public.perfis  add column if not exists dados         jsonb default '{}'::jsonb;
alter table public.perfis  add column if not exists criado_em     timestamptz default now();
alter table public.perfis  add column if not exists atualizado_em timestamptz default now();

alter table public.dados   add column if not exists conteudo      jsonb default '{}'::jsonb;
alter table public.dados   add column if not exists atualizado_em timestamptz default now();

alter table public.backups add column if not exists conteudo      jsonb;
alter table public.backups add column if not exists criado_em     timestamptz default now();

-- Faz a API REST enxergar a estrutura na hora
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Segurança
-- RLS ligado e SEM políticas: ninguém acessa com a chave pública (anon).
-- O servidor usa a chave service_role, que ignora RLS e fica só na Vercel.
-- ---------------------------------------------------------------------------
alter table public.perfis  enable row level security;
alter table public.dados   enable row level security;
alter table public.backups enable row level security;

-- ---------------------------------------------------------------------------
-- Conferência rápida (opcional): deve retornar as 3 tabelas criadas
-- ---------------------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public' order by table_name;
