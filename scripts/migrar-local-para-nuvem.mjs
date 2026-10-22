// ---------------------------------------------------------------------------
// Leva o que está no seu computador (perfis.json + licoes.json) para a nuvem.
//
//   npm run db:migrar
//
// Usa a API REST se SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY estiverem no .env
// (não precisa de senha). Se só houver DATABASE_URL, usa a conexão direta.
//
// • não apaga nada: insere ou atualiza pelo id;
// • pode rodar quantas vezes quiser.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const URL_API = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const CHAVE = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const usaApi = Boolean(URL_API && CHAVE);
const URL_BANCO = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
const raiz = process.cwd();

async function lerJson(nome) {
  const caminho = path.join(raiz, nome);
  try {
    return { caminho, dados: JSON.parse(await fs.readFile(caminho, 'utf-8')) };
  } catch (erro) {
    if (erro.code === 'ENOENT') return { caminho, dados: null };
    throw erro;
  }
}

const perfis = await lerJson('perfis.json');
const licoes = await lerJson('licoes.json');

if (!perfis.dados && !licoes.dados) {
  console.error('❌ Não encontrei perfis.json nem licoes.json nesta pasta:');
  console.error('  ', raiz);
  console.error('   Rode na pasta do projeto (onde fica o server.ts).');
  process.exit(1);
}

const listaPerfis = Array.isArray(perfis.dados) ? perfis.dados.filter(p => p && p.id) : [];
console.log('Lido do seu computador:');
console.log('  perfis: ', listaPerfis.length ? listaPerfis.map(p => p.nome).join(', ') : 'nenhum');
console.log(
  '  lições:',
  licoes.dados && Array.isArray(licoes.dados.licoes) ? `${licoes.dados.licoes.length} lições + configuração` : 'não encontrado'
);
console.log('  destino:', usaApi ? `API REST (${URL_API})` : URL_BANCO ? 'Postgres direto' : 'nenhum');
console.log('');

// ---------------------------------------------------------------------------
// Caminho A: API REST
// ---------------------------------------------------------------------------
async function rest(caminho, init = {}, prefer) {
  const cabecalhos = {
    apikey: CHAVE,
    Authorization: `Bearer ${CHAVE}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {})
  };
  const resposta = await fetch(`${URL_API}/rest/v1/${caminho}`, { ...init, headers: cabecalhos });
  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => '');
    throw new Error(`HTTP ${resposta.status}: ${texto.slice(0, 300)}`);
  }
}

async function migrarPorApi() {
  console.log('Enviando...');

  if (licoes.dados) {
    await rest(
      'dados?on_conflict=id',
      { method: 'POST', body: JSON.stringify({ id: 'principal', conteudo: licoes.dados, atualizado_em: new Date().toISOString() }) },
      'resolution=merge-duplicates,return=minimal'
    );
    console.log('✅ Lições e configuração enviadas.');
  }

  if (listaPerfis.length) {
    const linhas = listaPerfis.map(p => ({
      id: p.id,
      nome: String(p.nome || 'sem nome').slice(0, 60),
      cor: p.cor || '#6ee7ff',
      dados: p,
      atualizado_em: new Date().toISOString()
    }));
    await rest(
      'perfis?on_conflict=id',
      { method: 'POST', body: JSON.stringify(linhas) },
      'resolution=merge-duplicates,return=minimal'
    );
    listaPerfis.forEach(p => console.log(`✅ Perfil enviado: ${p.nome}`));
  }
}

// ---------------------------------------------------------------------------
// Caminho B: Postgres direto
// ---------------------------------------------------------------------------
async function migrarPorBanco() {
  const { Pool } = await import('pg');
  const senhaSeparada = (process.env.DB_SENHA || process.env.PGPASSWORD || '').trim();
  const u = new URL(URL_BANCO);
  const pool = new Pool({
    host: u.hostname,
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username || 'postgres'),
    password: senhaSeparada || decodeURIComponent(u.password || ''),
    database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    ssl: /localhost|127\.0\.0\.1/.test(URL_BANCO) ? undefined : { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: 15000
  });

  try {
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('perfis', 'dados', 'backups')`
    );
    const achadas = t.rows.map(r => r.table_name);
    const faltando = ['perfis', 'dados', 'backups'].filter(x => !achadas.includes(x));
    if (faltando.length) throw new Error(`Faltam tabelas: ${faltando.join(', ')}. Rode o supabase/schema.sql.`);

    if (licoes.dados) {
      await pool.query(
        `insert into public.dados (id, conteudo, atualizado_em)
         values ('principal', $1::jsonb, now())
         on conflict (id) do update set conteudo = excluded.conteudo, atualizado_em = now()`,
        [JSON.stringify(licoes.dados)]
      );
      console.log('✅ Lições e configuração enviadas.');
    }

    for (const p of listaPerfis) {
      await pool.query(
        `insert into public.perfis (id, nome, cor, dados, atualizado_em)
         values ($1, $2, $3, $4::jsonb, $5::timestamptz)
         on conflict (id) do update set
           nome = excluded.nome, cor = excluded.cor,
           dados = excluded.dados, atualizado_em = excluded.atualizado_em`,
        [p.id, String(p.nome || 'sem nome').slice(0, 60), p.cor || '#6ee7ff', JSON.stringify(p), new Date().toISOString()]
      );
      console.log(`✅ Perfil enviado: ${p.nome}`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

try {
  if (usaApi) await migrarPorApi();
  else if (URL_BANCO) await migrarPorBanco();
  else {
    console.error('❌ Nenhum destino configurado no .env.');
    console.error('   Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (recomendado) ou DATABASE_URL.');
    process.exit(1);
  }
  console.log('\n🎉 Migração concluída. Abra o app e confira em ⚙ → Diagnóstico.');
} catch (erro) {
  const msg = String(erro && erro.message ? erro.message : erro);
  console.error('\n❌ Falhou:', msg);
  if (/401|403|JWT|apikey/i.test(msg)) {
    console.error('   Chave inválida: use a "service_role" em SUPABASE_SERVICE_ROLE_KEY.');
  } else if (/PGRST205|does not exist|relation/i.test(msg)) {
    console.error('   As tabelas não existem: rode o supabase/schema.sql no SQL Editor.');
  }
  process.exitCode = 1;
}
