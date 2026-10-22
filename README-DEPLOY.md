# Deploy na Vercel + Supabase (competição entre amigos)

O app é o mesmo: `index.html` na frente e um Express atrás. Só mudou **onde os
dados ficam**: antes eram `perfis.json`/`licoes.json` no disco, agora é Postgres
(Supabase). Na Vercel o disco é somente leitura, então isso é obrigatório.

```
index.html              → site (estático, servido pela Vercel)
api/[...rota].ts        → função serverless que entrega tudo em /api/*
server.ts               → regras do curso (o mesmo de antes)
lib/store.ts            → Postgres quando existe DATABASE_URL,
                          arquivos locais quando não existe (dev)
supabase/schema.sql     → as 3 tabelas que você cria uma vez
```

---

## 1. Criar as tabelas (uma única vez)

Supabase → **SQL Editor** → *New query* → cole todo o conteúdo de
`supabase/schema.sql` → **Run**.

Você deve ficar com três tabelas em `public`: `perfis`, `dados` e `backups`.

> São 3 tabelas simples: uma linha por perfil (`dados` em JSONB), uma linha
> com as lições/configuração e uma tabela de backups automáticos.

## 2. Instalar a dependência nova

No seu computador, dentro da pasta do projeto:

```bash
npm install
```

Isso instala o driver `pg` (já está no `package.json`) e atualiza o
`package-lock.json`. **Comite essa mudança** — a Vercel instala pelo lockfile.

## 3. Testar localmente já com o banco

> ⚠️ **O app lê o arquivo `.env` — não o `.env.example`.**
> O `.env.example` é só o *modelo* que vai para o GitHub. Se você preencher
> valores reais nele, eles vão para o repositório. No Windows:
> `copy .env.example .env` e edite o **`.env`**.

**Caminho A (recomendado) — API REST, sem senha de banco:**

```env
SUPABASE_URL=https://SEU_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
CODIGO_ACESSO=meucodigo
```

Pegue os dois em **Supabase → Settings → API**: o *Project URL* e a chave
**service_role** (é a secreta; a *anon* não serve para gravar).

**Caminho B — conexão direta no Postgres (com senha):**

```env
DATABASE_URL=postgresql://postgres.SEU_PROJETO@aws-0-REGIAO.pooler.supabase.com:6543/postgres
DB_SENHA=a-senha-do-banco-sem-escapar
CODIGO_ACESSO=meucodigo
```

> **Por que a senha separada?** Se a senha tiver `#`, `@`, `%`, `/`, `:`, `?` ou
> `&`, colocá-la dentro da URL quebra o endereço (o `#`, por exemplo, corta a
> senha no meio e o login falha). Em `DB_SENHA` ela vai crua, sem escape.
>
> **Não dá para trocar a senha por SQL.** Em projetos novos do Supabase o papel
> `postgres` não é superusuário: `alter role ... password` retorna
> `42501: permission denied to alter role`. Use **Settings → Database → Reset
> database password**. É por isso que o Caminho A (REST) é mais simples.

Depois:

```bash
npm run dev
```

No terminal deve aparecer `Dados em: Supabase REST (...)` ou
`Dados em: Postgres (...)`. Se aparecer `arquivos locais`, o `.env` não foi lido.

### Conferir o banco sem subir o servidor

```bash
npm run db:teste:api    # caminho A (REST): testa URL + chave + tabelas
npm run db:teste        # caminho B (Postgres): testa host, usuário e senha
```

O `db:teste` mostra host, porta, **usuário**, tamanho da senha (nunca a senha
inteira), testa o login e lista as tabelas. Ele também avisa o erro mais comum:

> Na porta **6543** (pooler) o usuário é **`postgres.<project-ref>`** — com o
> ref do projeto depois do ponto. Na porta 5432 (direta) é só `postgres`.
> Trocar a senha no Supabase (Settings → Database) exige atualizar o `.env`.

Se aparecer `(ECIRCUITBREAKER) too many authentication failures`, o pooler
bloqueou novas tentativas depois de vários erros seguidos: espere 1–2 minutos.

### Levar suas lições e perfis do PC para a nuvem

```bash
npm run db:migrar
```

Lê `perfis.json` e `licoes.json` da pasta do projeto e grava no banco (insere ou
atualiza por id, nunca apaga). É o caminho mais rápido quando você já tem lições
criadas localmente — sem precisar exportar/importar um por um.

## 4. Subir na Vercel

1. **Add New → Project** → escolha o repositório do GitHub.
2. **Framework Preset: Other**. Build Command e Output Directory **em branco**
   (não existe build: o `index.html` é servido direto).
3. **Environment Variables** (em *Production* e *Preview*):

| Nome | Valor | Obrigatório |
|---|---|---|
| `DATABASE_URL` | a string do pooler (6543) | **sim** |
| `CODIGO_ACESSO` | o código que seus amigos vão digitar | recomendado |
| `JEV_API_KEY` | chave da TypeSafe (a IA do Jev) | opcional |

4. **Deploy**. A URL fica tipo `https://seu-projeto.vercel.app`.

O `vercel.json` já cuida de mandar tudo em `/api/*` para a função
`api/[...rota].ts`, e o `index.html` chama a API no mesmo domínio (sem CORS,
sem `localhost`).

## 5. Levar o progresso que já existe para a nuvem

O banco começa vazio. Para não perder o perfil que você treinou localmente:

1. No local (`npm run dev`, sem `DATABASE_URL`): **⚙ → Exportar perfil**.
2. No site da Vercel: **⚙ → Importar** e escolha o arquivo.
3. Repita para cada perfil, ou crie perfis novos direto na nuvem.

Também dá para copiar todos os perfis de uma vez: pegue o `perfis.json` local e
importe cada objeto pelo mesmo botão (ele aceita `{ "perfil": ... }` ou o
objeto solto).

### Limpando o repositório (se precisar)

Se `node_modules/`, `perfis.json`, `licoes.json` ou `backups/` já foram para o
GitHub antes do `.gitignore` existir, tire do controle de versão **sem apagar do
seu computador**:

```bash
git rm -r --cached node_modules perfis.json licoes.json backups
git commit -m "tira do repositorio arquivos locais e dependencias"
git push
```

Isso deixa o clone da Vercel muito menor e mais rápido.

## 6. Como a competição funciona

- Todo mundo usa o **mesmo link** e cria o **seu perfil** na tela inicial.
- O **Ranking** compara todos os perfis do banco: índice = WPM × precisão²,
  com mínimo de 3 lições para entrar na disputa (abaixo disso aparece
  *calibrando*, sem bagunçar a ordem).
- Cada perfil tem recordes próprios: melhor WPM, teste de 1 minuto, corrida de
  30s e jogo das palavras. As Métricas de cada um mostram constância e evolução.

## 7. Segurança — leia isto

- ⚠️ **Rotacione a senha do banco.** A connection string foi colada no chat;
  trate como vazada. Supabase → **Settings → Database → Reset database password**
  e atualize o `DATABASE_URL` no `.env` e na Vercel.
- **Nunca** comite o `.env` (já está no `.gitignore`).
- O `DATABASE_URL` só existe no servidor: o navegador nunca vê a senha.
- `CODIGO_ACESSO` é a proteção do grupo: sem ele, quem tiver o link entra e cria
  perfil. Com ele, todo `/api/*` exige o cabeçalho `x-codigo`.
- O SQL deixa **RLS ligado e sem políticas** nas tabelas: mesmo que alguém pegasse
  a chave pública do Supabase, não lê nada por ali.

## 8. Se algo falhar

Antes de tudo: no site, **⚙ → Diagnóstico → Testar conexão**. Ele diz na hora se
o banco está ligado,qual host está em uso e se a consulta funcionou.

| Sintoma | O que conferir |
|---|---|
| Erro 500 em todas as rotas | `DATABASE_URL` errado/ausente na Vercel → *Deployments → Functions → Logs* |
| `password authentication failed` | senha trocada ou string copiada incompleta |
| `relation "public.perfis" does not exist` | o `supabase/schema.sql` não foi executado |
| `timeout` / `ECONNREFUSED` | use a porta **6543** (pooler) e não a 5432 |
| Dados somem entre acessos | sem banco configurado a instância só tem memória |
| `Sem permissão de escrita local` no log | esperado na Vercel quando falta `DATABASE_URL` |
| Ranking não atualiza na hora | há um cache curto (15 s) por instância; recarregue a página |
| Vercel recusa o deploy falando de `functions` | apague o `vercel.json`: a função roda com os padrões |
| Erro aparece como JSON `{ "erro": ..., "detalhe": ... }` | o `detalhe` é a mensagem real do banco — é o que você quer ver |

Todas as falhas da API agora voltam em **JSON** com um campo `detalhe`, então o
log da Vercel mostra a causa em uma linha, em vez de uma página de stack trace.

## 9. Desenvolvimento sem internet/banco

Sem `DATABASE_URL`, o `lib/store.ts` volta a usar `perfis.json` e `licoes.json`
exatamente como antes — inclusive o `backups/` local. Você não perde o fluxo de
trabalho.

## 10. O que já está pronto para o grupo

- Perfis independentes, cada um com progresso, metas, recordes e conquistas.
- Ranking único comparando todos os perfis (índice = WPM × precisão²).
- Backups automáticos no próprio banco (últimos 20).
- Exportar/importar perfil em JSON — serve também como backup manual.
- Código de acesso opcional para o grupo não virar link público.
