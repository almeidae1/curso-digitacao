// ---------------------------------------------------------------------------
// Confere a conexão pelo caminho SEM SENHA: a API REST do Supabase.
//
//   npm run db:teste:api
//
// Precisa de duas variáveis no .env (Supabase → Settings → API):
//   SUPABASE_URL=https://SEU_REF.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ...
// ---------------------------------------------------------------------------
import 'dotenv/config';

const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const chave = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

function papelDaChave(k) {
  try {
    const partes = k.split('.');
    if (partes.length !== 3) return null;
    const json = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf-8'));
    return json.role || null;
  } catch {
    return null;
  }
}

if (!url || !chave) {
  console.error('❌ Faltam variáveis no .env:\n');
  if (!url) console.error('   SUPABASE_URL=https://SEU_REF.supabase.co   (Settings → API → Project URL)');
  if (!chave) console.error('   SUPABASE_SERVICE_ROLE_KEY=eyJ...          (Settings → API → service_role, botão Reveal/Copy)');
  console.error('\n   Atenção: é a chave "service_role" (secreta), NÃO a "anon".');
  process.exit(1);
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
  console.warn(`⚠️  A URL não parece o padrão https://REF.supabase.co → recebi: ${url}`);
}

const papel = papelDaChave(chave);
console.log('Conferindo a API REST do Supabase...\n');
console.log('  url:   ', url);
console.log('  chave: ', `${chave.slice(0, 10)}… (${chave.length} caracteres)`);
console.log(
  '  tipo:  ',
  chave.startsWith('sb_secret_')
    ? 'secret (chave secreta nova) ✅'
    : chave.startsWith('sb_publishable_')
      ? 'publishable (chave PÚBLICA) ❌ — não grava nada'
      : papel
        ? `jwt com papel "${papel}"`
        : 'formato não reconhecido (aceito mesmo assim)'
);

const avisos = [];
if (chave.startsWith('sb_publishable_')) {
  avisos.push('Essa é a chave PUBLISHABLE (pública). Ela respeita o RLS e NÃO grava nada.');
  avisos.push('   Use a "Secret key" — em Settings → API, a linha de baixo.');
} else if (chave.startsWith('sb_secret_')) {
  // chave nova secreta: é a equivalente ao service_role
} else if (papel === 'anon') {
  avisos.push('Essa é a chave "anon": respeita o RLS e NÃO grava nada. Use a "service_role".');
} else if (papel && papel !== 'service_role') {
  avisos.push(`A chave tem papel "${papel}". O esperado é service_role (ou uma sb_secret_...).`);
}

const cabecalhos = { apikey: chave, Authorization: `Bearer ${chave}` };

async function pegar(tabela, extra = '') {
  const resposta = await fetch(`${url}/rest/v1/${tabela}?select=id${extra}`, { headers: cabecalhos });
  const corpo = await resposta.text().catch(() => '');
  return { ok: resposta.ok, status: resposta.status, corpo };
}

try {
  const login = await fetch(`${url}/auth/v1/health`, { headers: cabecalhos });
  if (login.status === 401) {
    console.error('\n❌ A chave foi recusada (401). Copie de novo em Settings → API.');
    process.exitCode = 1;
  }

  const perfis = await pegar('perfis', '&limit=1');
  if (!perfis.ok) {
    console.error(`\n❌ Tabela "perfis" não respondeu (HTTP ${perfis.status}).`);
    if (perfis.status === 401 || perfis.status === 403) {
      console.error('   Chave inválida ou sem permissão. Use a service_role.');
    } else if (/PGRST205|does not exist|relation/i.test(perfis.corpo)) {
      console.error('   Login OK, mas a tabela não existe: rode o supabase/schema.sql no SQL Editor.');
    } else {
      console.error('   Detalhe:', perfis.corpo.slice(0, 300));
    }
    process.exitCode = 1;
  } else {
    const dados = await pegar('dados', '&limit=1');
    const backups = await pegar('backups', '&limit=1');
    const faltando = [];
    if (!dados.ok) faltando.push('dados');
    if (!backups.ok) faltando.push('backups');

    console.log('\n✅ Conexão com a API aceita.');
    if (faltando.length) {
      console.log(`\n⚠️  Tabelas faltando: ${faltando.join(', ')}`);
      console.log('   Supabase → SQL Editor → cole supabase/schema.sql → Run.');
    } else {
      console.log('✅ Tabelas perfis, dados e backups: todas acessíveis.');
      console.log('\nPode rodar "npm run dev". O app vai usar a API REST (sem senha de banco).');
    }
  }
} catch (erro) {
  console.error('\n❌ Falha de rede:', erro && erro.message ? erro.message : erro);
  console.error('   Confira a internet e se a URL é mesmo https://REF.supabase.co');
  process.exitCode = 1;
}

if (avisos.length) {
  console.log('\nAvisos:');
  avisos.forEach(a => console.log('  •', a));
}
