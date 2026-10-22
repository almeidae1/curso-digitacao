// ---------------------------------------------------------------------------
// Confere a conexão com o banco, sem subir o servidor.
//
//   npm run db:teste
//
// Mostra host, porta, usuário e tamanho da senha (nunca a senha inteira),
// testa o login, lista as tabelas e diz o que corrigir.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import { promises as fs } from 'node:fs';
import { Pool } from 'pg';

const url = (process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();

if (!url) {
  console.error('❌ DATABASE_URL vazia.');
  console.error('   Crie um arquivo .env na pasta do projeto (copie do .env.example).');
  process.exit(1);
}

let u;
try {
  u = new URL(url);
} catch {
  console.error('❌ A URL do banco não é válida. Confira se copiou a linha inteira.');
  process.exit(1);
}

const porta = u.port || '5432';
const usuario = decodeURIComponent(u.username || '');
const senhaUrl = decodeURIComponent(u.password || '');
const senhaEnv = (process.env.DB_SENHA || process.env.PGPASSWORD || '').trim();
const senha = senhaEnv || senhaUrl;
const banco = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres';
const projeto = usuario.includes('.') ? usuario.split('.').slice(1).join('.') : null;
const mascarar = s => `${s.slice(0, 1)}${'•'.repeat(Math.max(0, s.length - 2))}${s.slice(-1)}`;

console.log('Conferindo a conexão com o banco...\n');
console.log('  host:      ', u.hostname);
console.log('  porta:     ', porta);
console.log('  usuário:   ', usuario);
console.log('  banco:     ', banco);
console.log('  senha URL: ', senhaUrl ? `${mascarar(senhaUrl)} (${senhaUrl.length} caracteres)` : '(sem senha na URL)');
console.log('  DB_SENHA:  ', senhaEnv ? `${mascarar(senhaEnv)} (${senhaEnv.length} caracteres)` : '(não definida)');
if (u.search && u.search.length > 1) console.log('  extras:    ', u.search);
if (u.hash && u.hash.length > 1) {
  console.log('  #extra:    ', `(${u.hash.length - 1} caracteres depois do "#") — isso quase sempre é a senha cortada`);
}

const avisos = [];
if (porta === '6543' && !projeto) {
  avisos.push('Na porta 6543 (pooler) o usuário TEM que ser "postgres.<project-ref>". Está faltando o ".<project-ref>".');
  avisos.push('Pegue a string certa em: Supabase → Connect → Connection pooling (Transaction) → URI.');
}
if (porta === '5432' && projeto) {
  avisos.push('Na porta 5432 (conexão direta) o usuário é só "postgres", sem ".<project-ref>".');
}
if (!senha) avisos.push('Não há senha nem na URL nem em DB_SENHA.');
if (senha && senha !== senha.trim()) avisos.push('A senha começa ou termina com espaço.');
if (u.hash && u.hash.length > 1) {
  avisos.push('A URL tem uma parte depois de "#". Isso quase sempre é a senha contendo "#" sem escape:');
  avisos.push('   ponha a senha em DB_SENHA (sem escapar nada) e tire a senha de dentro da URL.');
}
if (senha && /[#@%\/:?&=\s]/.test(senha)) {
  avisos.push('A senha usada tem caractere especial — se o login falhar, confira se ela chegou inteira.');
}
if (senha && /[^\x20-\x7E]/.test(senha)) {
  avisos.push('A senha tem caractere invisível ou com acento (espaço, NBSP, acentuação). Recopie com cuidado.');
}

// ---------------------------------------------------------------------------
// Inspeção do .env cru: o dotenv corta valores no "#" quando não há aspas
// ---------------------------------------------------------------------------
let brutoEnv = '';
try {
  brutoEnv = await fs.readFile('.env', 'utf-8');
} catch {
  avisos.push('Não encontrei o arquivo .env nesta pasta (mas as variáveis vieram de outro lugar).');
}

if (brutoEnv) {
  const linhas = brutoEnv.split(/\r?\n/);
  const valorDaLinha = l => {
    const i = l.indexOf('=');
    return i < 0 ? '' : l.slice(i + 1).trim();
  };
  const semAspasDe = v => v.replace(/^(["'`])([\s\S]*)\1$/, '$2');

  // todas as linhas DB_SENHA (pode haver mais de uma — vale a última)
  const ocorrencias = [];
  linhas.forEach((l, indice) => {
    if (l.trim().startsWith('DB_SENHA=')) ocorrencias.push({ numero: indice + 1, valor: valorDaLinha(l) });
  });

  if (ocorrencias.length > 1) {
    avisos.push(`Achei ${ocorrencias.length} linhas DB_SENHA no .env — o dotenv usa a ÚLTIMA. Apague as repetidas.`);
  }
  ocorrencias.forEach(x => {
    const v = semAspasDe(x.valor);
    const dica = v.length ? `${v[0]}…${v[v.length - 1]}` : 'vazia';
    console.log(`  .env: linha ${x.numero} → ${v.length} caracteres (${dica})`);
  });

  const ultima = ocorrencias[ocorrencias.length - 1];
  if (ultima) {
    const valor = ultima.valor;
    const comAspas = valor.length >= 2 && /^(["'`])/.test(valor) && valor.endsWith(valor[0]);
    const conteudo = semAspasDe(valor);

    if (conteudo.includes('#') && !comAspas) {
      avisos.push('A linha DB_SENHA tem "#" SEM aspas: o dotenv corta o valor ali.');
      avisos.push('   Corrija assim, com aspas duplas:  DB_SENHA="sua#senha"');
    }
    if (/^["'`]/.test(valor) && !comAspas) {
      avisos.push('A linha DB_SENHA começa com aspas mas não fecha com a mesma aspa.');
    }
    if (conteudo.length !== senha.length) {
      avisos.push(
        `A linha do .env tem ${conteudo.length} caracteres, mas o programa recebeu ${senha.length}: ` +
          'algo está cortando o valor.'
      );
    }
  } else if (senhaEnv) {
    avisos.push('DB_SENHA chegou ao processo, mas não achei a linha no .env — ela veio do Windows ou de outro arquivo.');
  }

  const linhaUrl = linhas.find(l => l.trim().startsWith('DATABASE_URL='));
  if (linhaUrl && /:\/\/[^:/@]+:[^@]*@/.test(linhaUrl) && senhaEnv) {
    avisos.push('A DATABASE_URL tem senha dentro dela, mas DB_SENHA tem prioridade — a da URL é ignorada.');
  }
}

const pool = new Pool({
  host: u.hostname,
  port: Number(porta) || 5432,
  user: usuario,
  password: senha,
  database: banco,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000
});

try {
  const r = await pool.query('select current_user as usuario, current_database() as banco, version() as versao');
  console.log('\n✅ Login aceito pelo banco.');
  console.log('  usuário autenticado:', r.rows[0].usuario);
  console.log('  banco:              ', r.rows[0].banco);
  console.log('  servidor:           ', String(r.rows[0].versao).split(' ').slice(0, 2).join(' '));

  const t = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('perfis', 'dados', 'backups')
      order by table_name`
  );
  const achadas = t.rows.map(x => x.table_name);
  console.log('\nTabelas encontradas:', achadas.length ? achadas.join(', ') : 'nenhuma');

  const faltando = ['perfis', 'dados', 'backups'].filter(x => !achadas.includes(x));
  if (faltando.length) {
    console.log('\n⚠️  Falta criar:', faltando.join(', '));
    console.log('   Supabase → SQL Editor → cole o arquivo supabase/schema.sql → Run.');
  } else {
    const p = await pool.query('select count(*)::int as total from public.perfis');
    console.log(`\n✅ Tudo pronto: ${p.rows[0].total} perfil(is) no banco. Pode rodar "npm run dev".`);
  }
} catch (erro) {
  const msg = String(erro && erro.message ? erro.message : erro);
  console.error('\n❌ Falhou:', msg);

  if (/password authentication failed/i.test(msg)) {
    console.error('\nO usuário está certo — o que não bate é a senha.\n');
    console.error(`  • senha em uso: ${senha ? `${mascarar(senha)} (${senha.length} caracteres)` : 'vazia'}`);
    console.error('  • confira a senha atual em: Supabase → Settings → Database (ou resete de novo).');
    console.error('  • se a senha tem # @ % / : ? & =, tire ela da URL e use DB_SENHA no .env:');
    console.error('      DATABASE_URL=postgresql://postgres.SEU_REF@aws-0-REGIAO.pooler.supabase.com:6543/postgres');
    console.error('      DB_SENHA=sua-senha-sem-escapar-nada');
    console.error(`  • o projeto tem que ser o do ref "${projeto || '???'}" (você pode ter mais de um projeto).`);
  } else if (/ECIRCUITBREAKER|too many authentication failures/i.test(msg)) {
    console.error('\nO pooler bloqueou novas tentativas depois de vários erros seguidos.');
    console.error('  Espere de 1 a 2 minutos e rode de novo.');
  } else if (/relation .* does not exist/i.test(msg)) {
    console.error('\n→ O login funcionou, mas as tabelas não existem: rode o supabase/schema.sql.');
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    console.error('\n→ Host não encontrado. Confira a região (aws-0-...) na URL.');
  } else if (/timeout|ETIMEDOUT/i.test(msg)) {
    console.error('\n→ Sem resposta na porta. Use a 6543 (pooler) e confira sua internet/firewall.');
  }
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

if (avisos.length) {
  console.log('\nAvisos sobre a URL:');
  avisos.forEach(a => console.log('  •', a));
}
