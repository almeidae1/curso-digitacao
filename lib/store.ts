// ---------------------------------------------------------------------------
// Camada de persistência do curso.
//
// Duas formas, escolhidas automaticamente:
//   1. Com DATABASE_URL (Vercel / Supabase): Postgres — sobrevive a reinícios e
//      é compartilhado entre todas as instâncias.
//   2. Sem DATABASE_URL (desenvolvimento local): os mesmos perfis.json /
//      licoes.json de antes, na pasta do projeto.
//
// A connection string NUNCA fica no código: vem de variável de ambiente
// (Vercel → Settings → Environment Variables → DATABASE_URL).
// ---------------------------------------------------------------------------
import 'dotenv/config'; // garante o .env carregado mesmo se este módulo for importado primeiro
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/**
 * Lida na hora do uso, não na importação.
 * Motivo: os `import` executam ANTES do corpo do server.ts, então ler
 * `process.env` no topo do módulo pegaria o .env ainda não carregado.
 */
const urlBanco = (): string => (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

export const CAMINHO_PERFIS = path.join(process.cwd(), 'perfis.json');
export const CAMINHO_LICOES = path.join(process.cwd(), 'licoes.json');
export const PASTA_BACKUPS = path.join(process.cwd(), 'backups');
export const CAMINHO_ENV = path.join(process.cwd(), '.env');
export const MAXIMO_BACKUPS = 20;

/** Para o professor entender, sem expor a senha. */
function hostSeguro(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return 'endereço inválido';
  }
}

/** Texto curto (sem segredo) para o log de inicialização. */
export const descrever = (): string => {
  if (usandoApi()) {
    try {
      return `Supabase REST (${new URL(urlSupabase()).host})`;
    } catch {
      return 'Supabase REST';
    }
  }
  const url = urlBanco();
  if (!url) return 'arquivos locais (perfis.json / licoes.json)';
  return `Postgres (${hostSeguro(url)})`;
};

/** Explica, no terminal, por que o banco não foi usado. */
export async function diagnosticoEnv(): Promise<{
  caminhoEnv: string;
  arquivoEnvExiste: boolean;
  temDatabaseUrl: boolean;
  temPostgresUrl: boolean;
  temApi: boolean;
  host: string | null;
}> {
  const url = urlBanco();
  let arquivoEnvExiste = false;
  try {
    await fs.access(CAMINHO_ENV);
    arquivoEnvExiste = true;
  } catch {
    arquivoEnvExiste = false;
  }
  return {
    caminhoEnv: CAMINHO_ENV,
    arquivoEnvExiste,
    temDatabaseUrl: Boolean((process.env.DATABASE_URL || '').trim()),
    temPostgresUrl: Boolean((process.env.POSTGRES_URL || '').trim()),
    temApi: usandoApi(),
    host: usandoApi() ? null : url ? hostSeguro(url) : null
  };
}

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------
let pool: Pool | null = null;

/** Senha pode vir separada (DB_SENHA), o que dispensa escapar caracteres na URL. */
function senhaDoBanco(url: URL): string {
  const separada = (process.env.DB_SENHA || process.env.PGPASSWORD || '').trim();
  const valor = separada || (url.password ? decodeURIComponent(url.password) : '');
  // tolera quem colou com aspas em volta ("senha", 'senha')
  return valor.replace(/^(["'`])([\s\S]*)\1$/, '$2').trim();
}

function banco(): Pool {
  if (pool) return pool;
  const texto = urlBanco();
  const url = new URL(texto);
  const senha = senhaDoBanco(url);
  if (!senha) {
    console.warn(
      '⚠️  O banco está configurado mas não há senha: coloque a senha em DB_SENHA no .env ' +
        '(assim caracteres como # @ % / : não quebram a URL).'
    );
  }
  pool = new Pool({
    host: url.hostname,
    port: Number(url.port) || 5432,
    user: decodeURIComponent(url.username || 'postgres'),
    password: senha,
    database: (url.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    ssl: /localhost|127\.0\.0\.1/.test(texto) ? undefined : { rejectUnauthorized: false },
    max: 2, // poucas conexões por instância: o pooler do Supabase multiplexa
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', erro => console.warn('Conexão do Postgres caiu:', erro.message));
  return pool;
}

async function consultar<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const resultado = await banco().query(sql, params as never[]);
  return resultado.rows as T[];
}

// ---------------------------------------------------------------------------
// Arquivos locais (desenvolvimento)
// ---------------------------------------------------------------------------
async function lerJson(caminho: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(caminho, 'utf-8'));
  } catch (erro) {
    if ((erro as { code?: string }).code === 'ENOENT') return null;
    throw erro;
  }
}

async function gravarJson(caminho: string, dados: unknown): Promise<void> {
  const tmp = caminho + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(dados, null, 2), 'utf-8');
  await fs.rename(tmp, caminho);
}

/** Na Vercel o disco é somente leitura: avisa uma vez e segue. */
let avisouDisco = false;
async function gravarLocal(caminho: string, dados: unknown): Promise<void> {
  try {
    await gravarJson(caminho, dados);
  } catch (erro) {
    if (!avisouDisco) {
      avisouDisco = true;
      console.warn(
        'Sem permissão de escrita local:',
        erro instanceof Error ? erro.message : erro,
        '— configure DATABASE_URL para persistir no banco.'
      );
    }
  }
}

/** Cópia .bak do arquivo local (usada apenas quando a leitura falha). */
export async function copiarParaBak(caminho: string): Promise<void> {
  try {
    await fs.copyFile(caminho, caminho + '.bak');
  } catch {
    /* sem arquivo local: nada a copiar */
  }
}

// ---------------------------------------------------------------------------
// API REST do Supabase (PostgREST) — não precisa de senha de banco
// ---------------------------------------------------------------------------
const urlSupabase = (): string => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const chaveSupabase = (): string =>
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

/** true quando temos URL + chave: caminho preferido, sem senha de Postgres. */
export const usandoApi = (): boolean => Boolean(urlSupabase() && chaveSupabase());

export const naNuvem = (): boolean => usandoApi() || Boolean(urlBanco());

async function rest<T = unknown>(caminho: string, init: RequestInit = {}, prefer?: string): Promise<T> {
  const cabecalhos: Record<string, string> = {
    apikey: chaveSupabase(),
    Authorization: `Bearer ${chaveSupabase()}`,
    'Content-Type': 'application/json'
  };
  if (prefer) cabecalhos.Prefer = prefer;
  Object.assign(cabecalhos, init.headers || {});

  let resposta: Response;
  try {
    resposta = await fetch(`${urlSupabase()}/rest/v1/${caminho}`, { ...init, headers: cabecalhos });
  } catch (erro) {
    throw new Error(`Supabase (rede): ${erro instanceof Error ? erro.message : String(erro)}`);
  }

  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => '');
    throw new Error(`Supabase ${resposta.status}: ${texto.slice(0, 300) || resposta.statusText}`);
  }

  const tipo = resposta.headers.get('content-type') || '';
  if (tipo.includes('application/json')) return (await resposta.json()) as T;
  return null as T;
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------
export async function lerPerfis(): Promise<unknown | null> {
  if (!naNuvem()) return lerJson(CAMINHO_PERFIS);

  if (usandoApi()) {
    const linhas = await rest<{ dados: unknown }[]>('perfis?select=dados&order=criado_em.asc');
    return (linhas || []).map(linha => linha.dados);
  }

  const linhas = await consultar<{ dados: unknown }>(
    'select dados from public.perfis order by criado_em asc'
  );
  return linhas.map(linha => linha.dados);
}

export async function lerDados(): Promise<unknown | null> {
  if (!naNuvem()) return lerJson(CAMINHO_LICOES);

  if (usandoApi()) {
    const linhas = await rest<{ conteudo: unknown }[]>('dados?select=conteudo&id=eq.principal');
    return linhas && linhas.length ? linhas[0].conteudo : null;
  }

  const linhas = await consultar<{ conteudo: unknown }>(
    'select conteudo from public.dados where id = $1',
    ['principal']
  );
  return linhas.length ? linhas[0].conteudo : null;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
/** Insere/atualiza todos os perfis informados. Não apaga ninguém. */
export async function sincronizarPerfis(lista: unknown[]): Promise<void> {
  if (!naNuvem()) {
    await gravarLocal(CAMINHO_PERFIS, lista);
    return;
  }

  const registros = (lista as Array<{ id: string; nome?: string; cor?: string }>).filter(p => p && p.id);
  if (!registros.length) return;

  if (usandoApi()) {
    const linhas = registros.map(p => ({
      id: p.id,
      nome: String(p.nome || 'sem nome').slice(0, 60),
      cor: p.cor || '#6ee7ff',
      dados: p,
      atualizado_em: new Date().toISOString()
    }));
    await rest('perfis?on_conflict=id', { method: 'POST', body: JSON.stringify(linhas) }, 'resolution=merge-duplicates,return=minimal');
    return;
  }

  const valores: unknown[] = [];
  const marcadores = registros.map((p, i) => {
    const b = i * 5;
    valores.push(p.id, String(p.nome || 'sem nome').slice(0, 60), p.cor || '#6ee7ff', JSON.stringify(p), new Date().toISOString());
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb, $${b + 5}::timestamptz)`;
  });

  await consultar(
    `insert into public.perfis (id, nome, cor, dados, atualizado_em)
     values ${marcadores.join(', ')}
     on conflict (id) do update set
       nome = excluded.nome,
       cor = excluded.cor,
       dados = excluded.dados,
       atualizado_em = excluded.atualizado_em`,
    valores
  );
}

/** Remove o perfil do banco (chamado só quando alguém exclui de verdade). */
export async function apagarPerfil(id: string): Promise<void> {
  if (!naNuvem() || !id) return;

  if (usandoApi()) {
    await rest(`perfis?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }, 'return=minimal');
    return;
  }
  await consultar('delete from public.perfis where id = $1', [id]);
}

/** Lições, etapas e configuração de pontuação (uma linha só). */
export async function gravarDados(conteudo: unknown): Promise<void> {
  if (!naNuvem()) {
    await gravarLocal(CAMINHO_LICOES, conteudo);
    return;
  }

  if (usandoApi()) {
    await rest(
      'dados?on_conflict=id',
      { method: 'POST', body: JSON.stringify({ id: 'principal', conteudo, atualizado_em: new Date().toISOString() }) },
      'resolution=merge-duplicates,return=minimal'
    );
    return;
  }

  await consultar(
    `insert into public.dados (id, conteudo, atualizado_em)
     values ('principal', $1::jsonb, now())
     on conflict (id) do update set conteudo = excluded.conteudo, atualizado_em = now()`,
    [JSON.stringify(conteudo)]
  );
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------
export async function criarBackup(conteudo: unknown): Promise<string | null> {
  if (!naNuvem()) {
    try {
      await fs.mkdir(PASTA_BACKUPS, { recursive: true });
      const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
      const destino = path.join(PASTA_BACKUPS, `dados-${carimbo}.json`);
      await gravarJson(destino, conteudo);
      const arquivos = (await fs.readdir(PASTA_BACKUPS)).filter(f => f.endsWith('.json')).sort();
      const sobra = arquivos.length - MAXIMO_BACKUPS;
      for (let i = 0; i < sobra; i++) await fs.unlink(path.join(PASTA_BACKUPS, arquivos[i])).catch(() => {});
      return destino;
    } catch (erro) {
      console.warn('Backup local não foi criado:', erro instanceof Error ? erro.message : erro);
      return null;
    }
  }

  try {
    if (usandoApi()) {
      await rest('backups', { method: 'POST', body: JSON.stringify({ conteudo }) }, 'return=minimal');
      // mantém só os MAXIMO_BACKUPS mais recentes
      const antigos = await rest<{ id: number }[]>('backups?select=id&order=criado_em.asc&limit=200');
      const sobra = (antigos || []).slice(0, Math.max(0, (antigos || []).length - MAXIMO_BACKUPS));
      if (sobra.length) {
        await rest(`backups?id=in.(${sobra.map(x => x.id).join(',')})`, { method: 'DELETE' }, 'return=minimal');
      }
      return 'Supabase (REST)';
    }

    await consultar('insert into public.backups (conteudo) values ($1::jsonb)', [JSON.stringify(conteudo)]);
    await consultar(
      `delete from public.backups
       where id not in (
         select id from public.backups order by criado_em desc limit ${MAXIMO_BACKUPS}
       )`
    );
    return 'banco';
  } catch (erro) {
    console.warn('Backup no banco não foi criado:', erro instanceof Error ? erro.message : erro);
    return null;
  }
}

export async function listarBackups(): Promise<{
  origem: string;
  total: number;
  maximo: number;
  lista: { arquivo: string; bytes: number; em: string | null }[];
}> {
  if (!naNuvem()) {
    const vazio = {
      origem: PASTA_BACKUPS,
      total: 0,
      maximo: MAXIMO_BACKUPS,
      lista: [] as { arquivo: string; bytes: number; em: string | null }[]
    };
    try {
      await fs.mkdir(PASTA_BACKUPS, { recursive: true });
      const arquivos = (await fs.readdir(PASTA_BACKUPS)).filter(f => f.endsWith('.json')).sort().reverse();
      const lista = [];
      for (const f of arquivos.slice(0, 12)) {
        const st = await fs.stat(path.join(PASTA_BACKUPS, f)).catch(() => null);
        lista.push({ arquivo: f, bytes: st ? st.size : 0, em: st ? st.mtime.toISOString() : null });
      }
      return { origem: PASTA_BACKUPS, total: arquivos.length, maximo: MAXIMO_BACKUPS, lista };
    } catch {
      return vazio;
    }
  }

  if (usandoApi()) {
    const linhas = await rest<{ id: number; criado_em: string | null }[]>(
      'backups?select=id,criado_em&order=criado_em.desc&limit=12'
    );
    const todos = await rest<{ id: number }[]>('backups?select=id&limit=1000');
    return {
      origem: 'Supabase (tabela backups)',
      total: (todos || []).length,
      maximo: MAXIMO_BACKUPS,
      lista: (linhas || []).map(l => ({
        arquivo: `backup-${l.id}`,
        bytes: 0,
        em: l.criado_em ? new Date(l.criado_em).toISOString() : null
      }))
    };
  }

  const [total] = await consultar<{ total: string }>('select count(*)::text as total from public.backups');
  const linhas = await consultar<{ id: string; criado_em: Date | null }>(
    'select id, criado_em from public.backups order by criado_em desc limit 12'
  );
  return {
    origem: 'Postgres (tabela backups)',
    total: total ? Number(total.total) : linhas.length,
    maximo: MAXIMO_BACKUPS,
    lista: linhas.map(l => ({
      arquivo: `backup-${l.id}`,
      bytes: 0,
      em: l.criado_em ? new Date(l.criado_em).toISOString() : null
    }))
  };
}
