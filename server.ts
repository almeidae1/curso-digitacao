import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as store from './lib/store';

dotenv.config();

// Erros assÃ­ncronos aparecem no log em uma linha (importante na Vercel).
process.on('unhandledRejection', erro => {
  console.error('Promise rejeitada sem tratamento:', erro instanceof Error ? erro.message : erro);
});

// ---------------------------------------------------------------------------
// ConfiguraÃ§Ã£o
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const JEV_API_KEY = process.env.JEV_API_KEY;
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODELO = 'jev-latest';
const JEV_TIMEOUT_MS = 4000;

const CERTEZA_MINIMA = 0.3; // certeza = |p - 0,5| * 2; abaixo disso, vale a regra fixa (p entre 0,35 e 0,65)
const LIMIAR_DIFICULDADE = 0.7; // p mÃ­nima de 'muita dificuldade' para voltar de etapa
const PRECISAO_PADRAO = 85; // meta padrÃ£o de precisÃ£o (%)
const WPM_PADRAO_NOVA = 15; // meta padrÃ£o de velocidade para liÃ§Ãµes novas
const MAX_LICOES = 60;
const MIN_ERROS_FRACA = 2; // erros no mesmo exercÃ­cio para a tecla entrar na lista de treino
const LIMPAS_PARA_SAIR = 3; // exercÃ­cios seguidos sem erro para a tecla sair da lista
const TETO_TENTATIVAS = 10; // exercÃ­cios na mesma etapa antes de sugerir voltar
const DIAS_LIXEIRA = 30; // dias que um perfil excluÃ­do fica recuperÃ¡vel
const CODIGO_ACESSO = (process.env.CODIGO_ACESSO || '').trim(); // vazio = site aberto
// CÃ³digo do administrador: sÃ³ quem tem este cÃ³digo pode excluir/criar liÃ§Ãµes,
// mudar pontuaÃ§Ã£o, mexer na lixeira. Vazio = todos podem (comportamento antigo).
const CODIGO_ADMIN = (process.env.CODIGO_ADMIN || '').trim();

/** Responde 403 quando a aÃ§Ã£o exige o administrador e o cÃ³digo nÃ£o confere. */
function exigirAdmin(req: any, res: any, next: any) {
  if (!CODIGO_ADMIN) return next(); // sem cÃ³digo de admin configurado: liberado
  const enviado = String(req.get('x-admin') || '');
  if (enviado && enviado === CODIGO_ADMIN) return next();
  return res.status(403).json({
    erro: 'SÃ³ o administrador pode fazer isso. Entre com o cÃ³digo de administrador em Ajustes.',
    admin: true
  });
}

const app = express();
app.use(cors());

// A Vercel pode entregar o corpo jÃ¡ convertido em objeto. Nesse caso nÃ£o
// tentamos ler o fluxo outra vez (isso travaria a requisiÃ§Ã£o).
const jsonParser = express.json({ limit: '4mb' });
app.use((req, res, next) => {
  const corpo = (req as unknown as { body?: unknown }).body;
  if (corpo && typeof corpo === 'object' && Object.keys(corpo as object).length > 0) return next();
  return jsonParser(req, res, next);
});

// --- ping pÃºblico (a tela de acesso usa antes de tudo) ---
app.get('/api/ping', async (_req, res) => {
  let banco: boolean | null = null;
  if (store.naNuvem()) {
    try {
      await store.lerDados();
      banco = true;
    } catch {
      banco = false;
    }
  }
  res.json({
    ok: true,
    codigo: Boolean(CODIGO_ACESSO),
    admin: Boolean(CODIGO_ADMIN), // existe cÃ³digo de administrador configurado?
    adminOk: Boolean(CODIGO_ADMIN) && String(_req.get('x-admin') || '') === CODIGO_ADMIN,
    nuvem: store.naNuvem(),
    origem: store.descrever(),
    banco
  });
});

// --- cÃ³digo de acesso opcional (defina CODIGO_ACESSO na Vercel) ---
app.use('/api', (req, res, next) => {
  if (!CODIGO_ACESSO) return next();
  if (req.path === '/ping') return next();
  const enviado = String(req.get('x-codigo') || '');
  if (enviado && enviado === CODIGO_ACESSO) return next();
  return res.status(401).json({ erro: 'CÃ³digo de acesso invÃ¡lido.', codigo: true });
});

// --- inicializaÃ§Ã£o por instÃ¢ncia + leitura fresca do banco ---
app.use('/api', async (_req, _res, next) => {
  try {
    await iniciar();
    await garantirFresco();
    next();
  } catch (erro) {
    next(erro);
  }
});

// ---------------------------------------------------------------------------
// Apelidos de um pedaÃ§o sÃ³.
//
// Em alguns deploys (Vercel) a funÃ§Ã£o recebe apenas /api/<um-segmento>; rotas
// com barra no meio davam 404 na borda. Aqui reescrevemos os caminhos achatados
// para as rotas normais, entÃ£o o app funciona mesmo nesses casos:
//
//   /api/perfil?id=UUID          â†’  /api/perfis/UUID
//   /api/perfil-prefs            â†’  /api/perfis/UUID/prefs
//   /api/teste-texto             â†’  /api/testes/texto
// ---------------------------------------------------------------------------
app.use((req, _res, next) => {
  const url = req.url || '';
  if (!url.startsWith('/api/')) return next();

  const [caminho, busca] = url.split('?');
  const q = new URLSearchParams(busca || '');
  const corpo = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
  const id = q.get('id') || corpo.perfilId || corpo.id || '';
  const n = q.get('n') || corpo.n || corpo.licao || '';
  const seg = (v: string) => encodeURIComponent(String(v));

  let destino: string | null = null;
  switch (caminho) {
    case '/api/perfil':
      destino = id ? `/api/perfis/${seg(id)}` : null;
      break;
    case '/api/perfil-prefs':
      destino = id ? `/api/perfis/${seg(id)}/prefs` : null;
      break;
    case '/api/perfil-treinar':
      destino = id ? `/api/perfis/${seg(id)}/treinar` : null;
      break;
    case '/api/perfil-voltar':
      destino = id ? `/api/perfis/${seg(id)}/voltar-etapa` : null;
      break;
    case '/api/perfil-exportar':
      destino = id ? `/api/perfis/${seg(id)}/exportar` : null;
      break;
    case '/api/perfil-importar':
      destino = '/api/perfis/importar';
      break;
    case '/api/teste-texto':
      destino = '/api/testes/texto';
      break;
    case '/api/jogo-palavras':
      destino = '/api/jogo/palavras';
      break;
    case '/api/jogo-resultado':
      destino = '/api/jogo/resultado';
      break;
    case '/api/pratica-texto':
      destino = '/api/pratica/texto';
      break;
    case '/api/numero':
      destino = id ? `/api/numeros/${seg(id)}` : null;
      break;
    case '/api/licao-pontuacao':
      destino = n ? `/api/licoes/${seg(n)}/pontuacao` : null;
      break;
    case '/api/licao':
      destino = n ? `/api/licoes/${seg(n)}` : null;
      break;
    case '/api/avancado-pontuacao':
      destino = n ? `/api/avancado/licoes/${seg(n)}/pontuacao` : null;
      break;
    case '/api/avancado-automatico':
      destino = '/api/avancado/automatico';
      break;
    case '/api/avancado-nova':
      destino = '/api/avancado/licoes';
      break;
    case '/api/config-pontuacao':
      destino = '/api/config/pontuacao';
      break;
    default:
      destino = null;
  }

  if (destino) req.url = destino + (busca ? `?${busca}` : '');
  next();
});

// ---------------------------------------------------------------------------
// Palavras (sem acentos). SÃ³ entram na etapa "Palavras" as que usam apenas
// letras jÃ¡ aprendidas.
// ---------------------------------------------------------------------------
const PALAVRAS: string[] = [...new Set(`
a ao as da de do em eu um no na os se ou la ja me te ti ele ela nos mas por com sem sob ate que quem sim nao mais bem mal tao pra
casa mesa sala fala falas falsa salsa gala galas alga algas saga sagas dada dadas fada fadas safa asa asas haja bola dedo dedos mala lado dado sapo gato rato pato mato rua sol lua mar rio ave ovo uva avo ola oi
agua fogo vento terra chuva noite dia tarde cedo hora tempo ano mes semana vida morte amor odio paz guerra
pai mae filho filha irmao irma tio tia neto primo amigo amiga homem mulher gente povo
olho olhos nariz boca dente lingua mao maos perna pe unha pele osso sangue
verde azul preto branco cinza rosa roxo laranja amarelo vermelho cor claro escuro
dois tres quatro cinco seis sete oito nove dez cem mil
fazer dizer ver dar ir vir ter ser estar poder saber querer falar andar ler escrever abrir fechar subir descer correr pular sentar levar trazer pegar jogar gostar comer beber dormir sonhar amar
bom boa belo bela novo nova velho velha grande pequeno alto baixo longo curto forte fraco rapido lento leve pesado quente frio doce salgado
livro caderno lapis caneta papel carta nota texto frase palavra letra tecla teclado mouse tela
carro moto trem barco aviao estrada ponte porta janela chave cama sofa banho
pao leite cafe suco arroz feijao carne peixe frango queijo manga pera maca banana limao fruta bolo sal
escola aula prova mestre aluno aluna turma
cada tudo nada algo todo toda outro outra mesmo mesma ambos
pedra tipo ouro troca quase quero perto torre prato pesca ponto parte parque pessoa pergunta resposta
jogo jogos jaca jarro jeito julho junho jovem justo
kilo koala hoje agora depois antes ontem amanha sempre nunca muito pouco aqui ali
tela fita fato fogo fome fase festa filme fino fim final foto frase fruta fundo futuro
gelo gosto gordo grupo guia gente gado gasto gesso
lago lajota lama lance lanche lapis leao leite lenha letra lixo logo longe lugar luz
dama data dedo dia disco dois dono dor duvida duro
sede sede selo sera sinal sino sobre sonho sorte sorriso suave sul
altas alto asso assa assado falsas
`.split(/\s+/).filter(p => /^[a-zÃ§]{2,}$/.test(p)))]
  .concat(['alÃ§a', 'alÃ§as', 'calÃ§a', 'laÃ§o', 'faÃ§a', 'forÃ§a', 'braÃ§o', 'peÃ§a', 'moÃ§a', 'praÃ§a', 'cabeÃ§a', 'poÃ§a', 'caÃ§a']);

// ---------------------------------------------------------------------------
// LiÃ§Ãµes (salvas em licoes.json). As 4 primeiras sÃ£o fixas; as demais vocÃª cria.
// ---------------------------------------------------------------------------
type Licao = {
  numero: number;
  titulo: string;
  letras: string;
  precisaoMin: number; // meta de precisÃ£o (%) para passar de etapa
  wpmMin: number; // meta de velocidade (palavras por minuto) para passar de etapa
  fixa: boolean;
};

const LICOES_INICIAIS: Licao[] = [
  { numero: 1, titulo: 'Teclas Guia F e J (Indicadores)', letras: 'fj', precisaoMin: PRECISAO_PADRAO, wpmMin: 0, fixa: true },
  { numero: 2, titulo: 'PosiÃ§Ã£o de Base Esquerda (A S D F)', letras: 'asdf', precisaoMin: PRECISAO_PADRAO, wpmMin: 0, fixa: true },
  { numero: 3, titulo: 'PosiÃ§Ã£o de Base Direita (J K L Ã‡)', letras: 'jklÃ§', precisaoMin: PRECISAO_PADRAO, wpmMin: 0, fixa: true },
  { numero: 4, titulo: 'Linha de Base Completa (Ambas as MÃ£os)', letras: 'asdfjklÃ§', precisaoMin: PRECISAO_PADRAO, wpmMin: 0, fixa: true }
];

type TrilhaId = 'l' | 'a'; // l = liÃ§Ãµes de letras, a = AvanÃ§ado
type Pos = { trilha: TrilhaId; nivel: number; etapa: number };
type TipoEtapa = 'basico' | 'mistura' | 'palavras' | 'frases';
const NOME_ETAPA: Record<TipoEtapa, string> = {
  basico: 'SÃ³ as teclas da liÃ§Ã£o',
  mistura: 'Mistura com as liÃ§Ãµes anteriores',
  palavras: 'Palavras',
  frases: 'Frases do dia a dia'
};

let licoes: Licao[] = [];
type Pontuacao = { precisaoMin: number; wpmMin: number };
type Config = { modo: 'todas' | 'manual'; padrao: Pontuacao; avAutomatico: boolean };
let config: Config = { modo: 'manual', padrao: { precisaoMin: PRECISAO_PADRAO, wpmMin: WPM_PADRAO_NOVA }, avAutomatico: false };

const licaoPor = (n: number) => licoes.find(l => l.numero === n);
const tituloCompleto = (l: Licao) => `LiÃ§Ã£o ${l.numero}: ${l.titulo}`;
const letrasAnteriores = (n: number) => new Set(licoes.filter(l => l.numero < n).flatMap(l => [...l.letras]));
const letrasAcumuladas = (n: number) => new Set([...letrasAnteriores(n), ...(licaoPor(n)?.letras ?? '')]);

/** Palavras que sÃ³ usam letras jÃ¡ aprendidas e tÃªm pelo menos uma letra da liÃ§Ã£o. */
function palavrasDaL(n: number): string[] {
  const l = licaoPor(n);
  if (!l) return [];
  const acum = letrasAcumuladas(n);
  return PALAVRAS.filter(p => [...p].every(c => acum.has(c)) && [...p].some(c => l.letras.includes(c)));
}

/** Etapas que a liÃ§Ã£o tem (depende das letras e das liÃ§Ãµes anteriores). */
function etapasDaL(n: number): TipoEtapa[] {
  const l = licaoPor(n);
  const etapas: TipoEtapa[] = ['basico'];
  if (!l) return etapas;
  if ([...letrasAnteriores(n)].some(c => !l.letras.includes(c))) etapas.push('mistura');
  if (palavrasDaL(n).length >= 3) etapas.push('palavras');
  return etapas;
}

const tipoDaEtapaL = (n: number, etapa: number): TipoEtapa => {
  const e = etapasDaL(n);
  return e[Math.min(Math.max(etapa, 1), e.length) - 1];
};

const sortear = <T,>(lista: readonly T[]): T => lista[Math.floor(Math.random() * lista.length)];
const embaralhar = <T,>(lista: readonly T[]): T[] => {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Treino dirigido: pesos por tecla fraca (erros) e pares confundidos ("esperada>digitada"). */
type Treino = { teclas: Record<string, number>; pares: string[] };

/** Letras que realmente aparecem nos exercÃ­cios de uma etapa. */
function letrasDaEtapaL(n: number, etapa: number): Set<string> {
  const l = licaoPor(n);
  if (!l) return new Set();
  const tipo = tipoDaEtapaL(n, etapa);
  if (tipo === 'basico') return new Set(l.letras);
  if (tipo === 'mistura') return letrasAcumuladas(n);
  return new Set(palavrasDaL(n).flatMap(p => [...p]));
}

function sortearPonderado(itens: [string, number][]): string {
  let r = Math.random() * itens.reduce((soma, [, peso]) => soma + peso, 0);
  for (const [k, peso] of itens) {
    r -= peso;
    if (r <= 0) return k;
  }
  return itens[itens.length - 1][0];
}

/**
 * Gera o exercÃ­cio. Fica mais difÃ­cil conforme o nÃºmero da liÃ§Ã£o sobe
 * (mais grupos e grupos maiores). Com teclas fracas, o treino vira dirigido:
 * a maior parte do texto usa essas teclas (mais peso para quem errou mais)
 * e os pares confundidos aparecem alternados (ex: "lÃ§lÃ§").
 */
function gerarTextoL(n: number, etapa: number, treino?: Treino): string {
  const l = licaoPor(n);
  if (!l) return 'fj fj jf jf';
  const tipo = tipoDaEtapaL(n, etapa);
  const extra = Math.max(0, n - 4);
  const qtd = Math.min(4 + extra, 10);
  const tamMax = Math.min(4 + Math.floor(extra / 2), 6);

  const naEtapa = letrasDaEtapaL(n, etapa);
  const pesos = Object.entries(treino?.teclas ?? {}).filter(([k]) => naEtapa.has(k));
  const pares = (treino?.pares ?? []).map(p => p.split('>')).filter(([a, b]) => naEtapa.has(a) && naEtapa.has(b));

  if (tipo === 'palavras') {
    const todas = palavrasDaL(n);
    const pontos = (p: string) => [...p].reduce((soma, c) => soma + (Object.fromEntries(pesos)[c] ?? 0), 0);
    const comFoco = pesos.length ? todas.filter(p => pontos(p) > 0) : [];
    const usadas = new Set<string>();
    const escolhidas: string[] = [];
    for (let i = 0; i < qtd; i++) {
      const usarFoco = comFoco.length > 0 && Math.random() < 0.75;
      const pool = usarFoco ? comFoco : todas;
      const livres = pool.filter(p => !usadas.has(p));
      const candidatas = livres.length ? livres : pool;
      const p = usarFoco ? sortearPonderado(candidatas.map(w => [w, pontos(w)] as [string, number])) : sortear(candidatas);
      usadas.add(p);
      escolhidas.push(p);
    }
    return escolhidas.join(' ');
  }

  const poolLetras = tipo === 'basico' ? [...l.letras] : [...letrasAcumuladas(n)];
  const grupos: string[] = [];
  for (let i = 0; i < qtd; i++) {
    const tamanho = 2 + Math.floor(Math.random() * (tamMax - 1));
    let grupo = '';
    if (pares.length > 0 && Math.random() < 0.35) {
      // par confundido: alterna as duas teclas
      const par = sortear(pares);
      const ini = Math.random() < 0.5 ? 0 : 1;
      for (let j = 0; j < tamanho; j++) grupo += par[(j + ini) % 2];
    } else {
      for (let j = 0; j < tamanho; j++) {
        if (pesos.length > 0 && Math.random() < 0.75) grupo += sortearPonderado(pesos);
        else if (tipo === 'mistura' && Math.random() < 0.55) grupo += sortear([...l.letras]);
        else grupo += sortear(poolLetras);
      }
    }
    grupos.push(grupo);
  }
  return grupos.join(' ');
}

// ---------------------------------------------------------------------------
// Trilha AVANÃ‡ADO: liÃ§Ãµes criadas pelo sistema, sÃ³ palavras e frases do dia a dia.
// AvanÃ§ado 1 = letras das liÃ§Ãµes 1 a 5, AvanÃ§ado 2 = liÃ§Ãµes 1 a 10 (ou atÃ© a Ãºltima
// que existir), AvanÃ§ado 3 em diante = tudo, da liÃ§Ã£o 1 atÃ© a Ãºltima criada.
// Nenhuma IA geradora: frases vÃªm de um banco fixo e de modelos (artigo + nome + verbo...).
// ---------------------------------------------------------------------------
const LIBERA_AVANCADO = 5; // o AvanÃ§ado abre depois de concluir esta liÃ§Ã£o
type AvLicao = { numero: number; precisaoMin: number; wpmMin: number; auto: boolean };
let avLicoes: AvLicao[] = [];
const AV_INICIAIS: AvLicao[] = [
  { numero: 1, precisaoMin: 90, wpmMin: 20, auto: false },
  { numero: 2, precisaoMin: 90, wpmMin: 22, auto: false },
  { numero: 3, precisaoMin: 92, wpmMin: 25, auto: false }
];

const avEscopoAte = (n: number) => (n === 1 ? 5 : n === 2 ? 10 : Infinity);
const avLetras = (n: number) => new Set(licoes.filter(l => l.numero <= avEscopoAte(n)).flatMap(l => [...l.letras]));
const avEscopoTexto = (n: number) => `LiÃ§Ãµes 1 a ${Math.min(avEscopoAte(n), licoes.length)}`;
const avTitulo = (n: number) =>
  `AvanÃ§ado ${n}: ${n <= 2 ? avEscopoTexto(n) : n === 3 ? 'Tudo que vocÃª aprendeu' : `Desafio ${n - 3}`}`;

/** PrÃ³xima liÃ§Ã£o avanÃ§ada: sempre um pouco mais difÃ­cil (meta sobe +1% e +2 palavras/min, atÃ© o teto). */
function novaAvLicao(auto: boolean): AvLicao {
  const n = avLicoes.length + 1;
  const passos = Math.max(0, n - 3);
  return { numero: n, auto, precisaoMin: Math.min(98, 92 + passos), wpmMin: Math.min(80, 25 + 2 * passos) };
}

type Vista = { numero: number; titulo: string; precisaoMin: number; wpmMin: number };
function vistaDa(trilha: TrilhaId, n: number): Vista | undefined {
  if (trilha === 'l') {
    const l = licaoPor(n);
    return l && { numero: l.numero, titulo: tituloCompleto(l), precisaoMin: l.precisaoMin, wpmMin: l.wpmMin };
  }
  const a = avLicoes.find(x => x.numero === n);
  return a && { numero: n, titulo: avTitulo(n), precisaoMin: a.precisaoMin, wpmMin: a.wpmMin };
}

const palavrasCom = (letras: Set<string>) => PALAVRAS.filter(p => [...p].every(c => letras.has(c)));

// --- vocabulÃ¡rio (sem acentos; Ã§ sÃ³ aparece se a liÃ§Ã£o do Ã‡ jÃ¡ foi aprendida) ---
const NOMES_M = ['gato', 'cachorro', 'menino', 'homem', 'pai', 'amigo', 'irmao', 'carro', 'livro', 'cafe', 'pao', 'sol', 'dia', 'trabalho', 'jogo', 'campo', 'mar', 'rio', 'vento', 'filho', 'professor', 'aluno', 'vizinho', 'patrao', 'barco', 'trem', 'onibus', 'banco', 'prato', 'copo', 'bolo', 'leite', 'suco', 'peixe', 'sapato', 'relogio', 'celular', 'telefone', 'caderno', 'lapis', 'mercado', 'parque', 'portao', 'quarto', 'banho', 'sono', 'cliente'];
const NOMES_F = ['menina', 'mulher', 'mae', 'amiga', 'irma', 'casa', 'mesa', 'sala', 'porta', 'janela', 'chave', 'cama', 'rua', 'escola', 'aula', 'agua', 'fruta', 'cidade', 'praia', 'loja', 'noite', 'tarde', 'manha', 'semana', 'hora', 'vida', 'festa', 'musica', 'caneta', 'bolsa', 'camisa', 'roupa', 'comida', 'viagem', 'conta', 'nota', 'carta', 'lista', 'tarefa', 'prova', 'padaria', 'farmacia', 'estrada', 'ponte', 'chuva', 'luz', 'fila', 'moÃ§a', 'praÃ§a', 'cabeÃ§a'];
const VERBOS_I = ['dorme', 'corre', 'chora', 'ri', 'sai', 'chega', 'volta', 'fala', 'canta', 'anda', 'trabalha', 'estuda', 'acorda', 'mora', 'vive', 'brinca', 'descansa', 'demora', 'funciona', 'cai', 'sobe', 'desce', 'passa', 'ajuda', 'almoÃ§a', 'comeÃ§a', 'janta', 'sorri', 'pula', 'nada', 'joga', 'cresce'];
const VERBOS_T = ['come', 'bebe', 'pega', 'abre', 'fecha', 'leva', 'traz', 'compra', 'vende', 'quer', 'tem', 'usa', 'faz', 've', 'le', 'escreve', 'lava', 'limpa', 'procura', 'encontra', 'perde', 'guarda', 'ouve', 'ama', 'conhece', 'prepara', 'paga', 'esquece'];
const ADJETIVOS: [string, string][] = [['grande', 'grande'], ['pequeno', 'pequena'], ['bonito', 'bonita'], ['velho', 'velha'], ['novo', 'nova'], ['alto', 'alta'], ['baixo', 'baixa'], ['bom', 'boa'], ['forte', 'forte'], ['fraco', 'fraca'], ['quente', 'quente'], ['frio', 'fria'], ['doce', 'doce'], ['rapido', 'rapida'], ['lento', 'lenta'], ['calmo', 'calma'], ['feliz', 'feliz'], ['triste', 'triste'], ['cansado', 'cansada'], ['limpo', 'limpa'], ['sujo', 'suja'], ['cheio', 'cheia'], ['vazio', 'vazia'], ['barato', 'barata'], ['caro', 'cara'], ['facil', 'facil'], ['gostoso', 'gostosa'], ['claro', 'clara'], ['escuro', 'escura'], ['leve', 'leve'], ['pesado', 'pesada']];
const ADVERBIOS = ['muito', 'bem', 'mal', 'hoje', 'ontem', 'amanha', 'sempre', 'nunca', 'agora', 'depois', 'cedo', 'tarde', 'aqui', 'ali', 'la', 'devagar'];
const TEMPOS = ['hoje', 'amanha', 'ontem', 'agora'];
const CONJUNCOES = ['e', 'mas', 'quando', 'porque'];
const FRASES_FIXAS = ['bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'como vai voce', 'ate logo', 'ate amanha', 'muito obrigado', 'de nada', 'por favor', 'com licenÃ§a', 'desculpe o atraso', 'que dia lindo', 'vamos para casa', 'onde fica o banco', 'quanto custa isso', 'eu gosto de cafe', 'hoje faz sol', 'amanha vai chover', 'a conta por favor', 'vou ao mercado', 'preciso de ajuda', 'pode me ajudar', 'ja volto', 'nao sei de nada', 'esta tudo certo', 'qual e o seu nome', 'onde esta a chave', 'o jantar esta pronto', 'o cafe esta quente', 'a casa esta limpa', 'eu moro perto daqui', 'vou dormir cedo hoje', 'vamos jogar bola', 'a agua esta fria', 'ele chegou tarde', 'ela saiu cedo', 'o onibus ja passou', 'a loja abre cedo', 'preciso comprar pao', 'hoje e sabado', 'amanha e domingo', 'quero um copo de agua', 'faz muito calor hoje', 'a fila esta grande', 'o trem demora muito', 'feche a porta por favor', 'ligue para a mae', 'ja almocei hoje', 'vou pagar a conta', 'o preco esta bom', 'a aula comeÃ§a cedo', 'ele gosta de musica', 'a menina leu a carta', 'o professor chegou', 'vamos ao parque hoje', 'a praia esta cheia', 'o sol saiu de novo', 'preciso de um lapis', 'abra a janela agora', 'a chuva passou', 'o filho esta dormindo', 'nos vamos sair cedo'];

type Aceita = (palavra: string) => boolean;
type Modelo = (ok: Aceita) => string | null;
const escolher = (lista: readonly string[], ok: Aceita) => {
  const c = lista.filter(ok);
  return c.length ? sortear(c) : null;
};
function substantivoComArtigo(ok: Aceita): { txt: string; nome: string; g: 'm' | 'f' } | null {
  const g = Math.random() < 0.5 ? 'm' : 'f';
  const nome = escolher(g === 'm' ? NOMES_M : NOMES_F, ok);
  const art = escolher(g === 'm' ? ['o', 'um'] : ['a', 'uma'], ok);
  return nome && art ? { txt: `${art} ${nome}`, nome, g } : null;
}

const M_SIMPLES: Modelo = ok => { const s = substantivoComArtigo(ok), v = escolher(VERBOS_I, ok); return s && v ? `${s.txt} ${v}` : null; };
const M_ADVERBIO: Modelo = ok => { const s = substantivoComArtigo(ok), v = escolher(VERBOS_I, ok), a = escolher(ADVERBIOS, ok); return s && v && a ? `${s.txt} ${v} ${a}` : null; };
const M_SER: Modelo = ok => {
  const s = substantivoComArtigo(ok);
  if (!s || !ok('e')) return null;
  const adj = escolher(ADJETIVOS.map(([m, f]) => (s.g === 'm' ? m : f)), ok);
  return adj ? `${s.txt} e ${adj}` : null;
};
const M_PRONOME: Modelo = ok => { const p = escolher(['ele', 'ela'], ok), v = escolher(VERBOS_I, ok), a = escolher(ADVERBIOS, ok); return p && v && a ? `${p} ${v} ${a}` : null; };
const M_TRANSITIVO: Modelo = ok => { const s = substantivoComArtigo(ok), v = escolher(VERBOS_T, ok), o = substantivoComArtigo(ok); return s && v && o ? `${s.txt} ${v} ${o.txt}` : null; };
const M_LUGAR: Modelo = ok => {
  const s = substantivoComArtigo(ok), v = escolher(VERBOS_I, ok);
  const g = Math.random() < 0.5 ? 'm' : 'f';
  const prep = escolher([g === 'm' ? 'no' : 'na'], ok), lugar = escolher(g === 'm' ? NOMES_M : NOMES_F, ok);
  return s && v && prep && lugar ? `${s.txt} ${v} ${prep} ${lugar}` : null;
};
const M_TEMPO: Modelo = ok => { const t = escolher(TEMPOS, ok), s = substantivoComArtigo(ok), v = escolher(VERBOS_I, ok); return t && s && v ? `${t} ${s.txt} ${v}` : null; };

/** Mais difÃ­cil = modelos mais variados, depois duas e trÃªs oraÃ§Ãµes ligadas por "e", "mas"... */
function gerarFraseModelo(n: number, ok: Aceita): string | null {
  const base = n <= 1 ? [M_SIMPLES, M_ADVERBIO, M_SER, M_PRONOME] : [M_SIMPLES, M_ADVERBIO, M_SER, M_PRONOME, M_TRANSITIVO, M_LUGAR, M_TEMPO];
  const uma = () => sortear(base)(ok);
  if (n >= 3 && Math.random() < 0.6) {
    const a = uma(), b = uma(), conj = escolher(CONJUNCOES, ok);
    if (a && b && conj) {
      if (n >= 6 && Math.random() < 0.5) {
        const c = uma(), conj2 = escolher(CONJUNCOES, ok);
        if (c && conj2) return `${a} ${conj} ${b} ${conj2} ${c}`;
      }
      return `${a} ${conj} ${b}`;
    }
  }
  return uma();
}

function poolFrases(n: number, letras: Set<string>): string[] {
  const ok: Aceita = w => [...w].every(c => letras.has(c));
  const fixas = FRASES_FIXAS.filter(f => [...f].every(c => c === ' ' || letras.has(c)));
  const pool = new Set<string>(fixas);
  // frases do dia a dia emendadas ("hoje faz sol e amanha vai chover") para os nÃ­veis mais difÃ­ceis
  if (n >= 3 && fixas.length >= 2) {
    for (let i = 0; i < 40 && ok('e'); i++) {
      const a = sortear(fixas), b = sortear(fixas);
      if (a !== b) pool.add(`${a} e ${b}`);
    }
  }
  for (let i = 0; i < 400 && pool.size < 90; i++) {
    const f = gerarFraseModelo(n, ok);
    if (f) pool.add(f);
  }
  return [...pool];
}

function gerarTextoAv(n: number, etapa: number, treino?: Treino): string {
  const letras = avLetras(n);
  const tipos = etapasDa('a', n);
  const tipo = tipos[Math.min(Math.max(etapa, 1), tipos.length) - 1];
  const pesos = Object.fromEntries(Object.entries(treino?.teclas ?? {}).filter(([k]) => letras.has(k)));
  const pontos = (txt: string) => [...txt].reduce((s, c) => s + (pesos[c] ?? 0), 0);
  const naturais = (t: string) => FRASES_FIXAS.some(f => t === f || t.includes(f)); // frases de verdade pesam mais que as de modelo
  const escolhePonderado = (lista: string[], qtd: number) => {
    const sobra = new Set(lista), out: string[] = [];
    while (out.length < qtd && sobra.size > 0) {
      const itens = [...sobra].map(t => [t, (1 + pontos(t) * 1.5) * (naturais(t) ? 3 : 1)] as [string, number]);
      const t = sortearPonderado(itens);
      sobra.delete(t);
      out.push(t);
    }
    return out;
  };

  if (tipo === 'palavras') {
    const todas = palavrasCom(letras);
    const minLen = Math.min(3 + n, 7);
    const longas = todas.filter(p => p.length >= minLen);
    const qtd = Math.min(4 + n, 10);
    return escolhePonderado(longas.length >= qtd ? longas : todas, qtd).join(' ');
  }

  const qtd = Math.min(2 + Math.floor(n / 2), 5);
  const alvo = Math.min(16 + 5 * n, 60);
  const pool = poolFrases(n, letras).sort((a, b) => Math.abs(a.length - alvo) - Math.abs(b.length - alvo));
  if (pool.length > 0) return escolhePonderado(pool.slice(0, Math.max(qtd * 3, 6)), qtd).join(' ');

  // poucas letras: ainda nÃ£o dÃ¡ para formar frases, usa sequÃªncias de palavras (ou de letras)
  const palavras = palavrasCom(letras);
  if (palavras.length >= 3) return escolhePonderado(palavras, qtd * 2).join(' ');
  const base = [...letras];
  return Array.from({ length: qtd * 2 }, () => Array.from({ length: 3 }, () => sortear(base)).join('')).join(' ');
}

// --- despachos entre as duas trilhas ---
const palavrasDa = (trilha: TrilhaId, n: number) => (trilha === 'a' ? palavrasCom(avLetras(n)) : palavrasDaL(n));
function etapasDa(trilha: TrilhaId, n: number): TipoEtapa[] {
  if (trilha === 'a') return palavrasCom(avLetras(n)).length >= 3 ? ['palavras', 'frases'] : ['frases'];
  return etapasDaL(n);
}
const tipoDaEtapa = (trilha: TrilhaId, n: number, etapa: number): TipoEtapa => {
  const e = etapasDa(trilha, n);
  return e[Math.min(Math.max(etapa, 1), e.length) - 1];
};
const rotuloPosicao = (trilha: TrilhaId, n: number, etapa: number) => {
  const v = vistaDa(trilha, n);
  const total = etapasDa(trilha, n).length;
  const e = Math.min(Math.max(etapa, 1), total);
  return `${v ? v.titulo : `LiÃ§Ã£o ${n}`} Â· Etapa ${e}/${total}: ${NOME_ETAPA[tipoDaEtapa(trilha, n, e)]}`;
};
const letrasDaEtapa = (trilha: TrilhaId, n: number, etapa: number) => (trilha === 'a' ? avLetras(n) : letrasDaEtapaL(n, etapa));
const gerarTexto = (trilha: TrilhaId, n: number, etapa: number, treino?: Treino) =>
  trilha === 'a' ? gerarTextoAv(n, etapa, treino) : gerarTextoL(n, etapa, treino);


// ---------------------------------------------------------------------------
// Constantes de dados (quem persiste Ã© o lib/store.ts: Postgres ou arquivos)
// ---------------------------------------------------------------------------
const CORES_PERFIL = ['#6ee7ff', '#b57bff', '#4ade80', '#ffd84a', '#ff9f4a', '#ff5d7a'] as const;
const HISTORICO_MAX = 300;

type RegistroLicao = {
  data: string;
  nivel: number; // nÃºmero da liÃ§Ã£o
  etapa?: number;
  trilha?: TrilhaId; // 'a' = AvanÃ§ado (ausente = liÃ§Ãµes de letras)
  wpm: number;
  precisao: number;
  segundos: number;
  decididoPor: 'jev' | 'regra';
  confianca: number | null;
  fluencia: number | null;
  teclaFraca: string | null;
};
type Perfil = {
  id: string;
  nome: string;
  cor: string;
  criadoEm: string;
  nivel: number; // liÃ§Ã£o atual
  etapa: number; // etapa atual dentro da liÃ§Ã£o
  concluidaAte: number; // maior liÃ§Ã£o jÃ¡ concluÃ­da (a prÃ³xima estÃ¡ liberada)
  fracas: Record<string, { semErro: number; peso: number }>; // teclas em treino (2+ erros); saem apÃ³s 3 exercÃ­cios limpos
  fracasPares: Record<string, { semErro: number; peso: number }>; // trocas "esperada>digitada" em treino
  trilha: TrilhaId; // trilha em que o aluno estÃ¡ treinando agora
  av: { nivel: number; etapa: number; concluidaAte: number }; // progresso no AvanÃ§ado
  tentativasEtapa: number; // exercÃ­cios seguidos na etapa atual
  perfeitosSeguidos: number; // exercÃ­cios seguidos com 100% de precisÃ£o
  historico: RegistroLicao[];
  teclas: Record<string, { t: number; e: number; m?: number; c?: number }>; // tentativas, erros e soma/contagem de tempo por tecla

  // ---- painel do aluno (tudo opcional: perfis antigos sÃ£o migrados em normalizarExtras) ----
  prefs?: Prefs; // revisÃ£o de inatividade, meta do dia, preferÃªncias do jogo
  recordes?: Recordes; // melhores marcas por modalidade
  atividade?: Record<string, number>; // dia (AAAA-MM-DD) -> sessÃµes concluÃ­das
  atividadeMin?: Record<string, number>; // dia -> minutos treinados
  testes?: ResultadoTeste[]; // histÃ³rico dos testes cronometrados (1 min e 30 s)
  jogoHistorico?: ResultadoJogo[]; // partidas do jogo das palavras
  conquistas?: Conquista[]; // medalhas jÃ¡ ganhas
  numeros?: Record<string, NumeroResultado>; // melhor resultado em cada exercÃ­cio de nÃºmeros e sÃ­mbolos
  melhorCombo?: number; // recorde de acertos seguidos (persistido)
  idsProcessados?: string[]; // evita contar duas vezes um envio reenviado pela fila
  excluidoEm?: string | null; // quando estÃ¡ na lixeira (null/ausente = ativo)
};

// perfis ativos (aparecem na lista, no ranking e nas rotas)
let perfis: Perfil[] = [];
// perfis na lixeira: nÃ£o aparecem em lugar nenhum, mas podem ser restaurados
let lixeira: Perfil[] = [];

function posDe(p: Perfil): Pos {
  return p.trilha === 'a' ? { trilha: 'a', nivel: p.av.nivel, etapa: p.av.etapa } : { trilha: 'l', nivel: p.nivel, etapa: p.etapa };
}
function definirPos(p: Perfil, pos: Pos) {
  p.trilha = pos.trilha;
  if (pos.trilha === 'a') { p.av.nivel = pos.nivel; p.av.etapa = pos.etapa; }
  else { p.nivel = pos.nivel; p.etapa = pos.etapa; }
}
let fila: Promise<void> = Promise.resolve();

/** Garante que o perfil tem os campos novos e que a posiÃ§Ã£o ainda existe. */
function ajustarPerfil(p: Perfil) {
  const total = Math.max(licoes.length, 1);
  if (!Number.isInteger(p.nivel) || p.nivel < 1) p.nivel = 1;
  if (!Number.isInteger(p.concluidaAte)) p.concluidaAte = Math.max(0, p.nivel - 1); // perfis antigos
  p.concluidaAte = Math.min(Math.max(p.concluidaAte, 0), total);
  p.nivel = Math.min(p.nivel, p.concluidaAte + 1, total);
  if (!Number.isInteger(p.etapa) || p.etapa < 1) p.etapa = 1;
  p.etapa = Math.min(p.etapa, etapasDa('l', p.nivel).length);
  p.av ??= { nivel: 1, etapa: 1, concluidaAte: 0 };
  const totalAv = Math.max(avLicoes.length, 1);
  p.av.concluidaAte = Math.min(Math.max(Number.isInteger(p.av.concluidaAte) ? p.av.concluidaAte : 0, 0), totalAv);
  p.av.nivel = Math.min(Math.max(Number.isInteger(p.av.nivel) ? p.av.nivel : 1, 1), p.av.concluidaAte + 1, totalAv);
  p.av.etapa = Math.min(Math.max(Number.isInteger(p.av.etapa) ? p.av.etapa : 1, 1), etapasDa('a', p.av.nivel).length);
  if (p.trilha !== 'a' || p.concluidaAte < LIBERA_AVANCADO) p.trilha = 'l';
  p.fracas ??= {};
  p.fracasPares ??= {};
  if (!Number.isInteger(p.tentativasEtapa) || p.tentativasEtapa < 0) p.tentativasEtapa = 0;
  if (!Number.isInteger(p.perfeitosSeguidos) || p.perfeitosSeguidos < 0) p.perfeitosSeguidos = 0;
  normalizarExtras(p);
}

/** Grava as liÃ§Ãµes avisando (em vez de derrubar) quando o banco nÃ£o aceita. */
async function gravarLicoesSeguro(gravarDepois: boolean): Promise<void> {
  if (!gravarDepois) return;
  try {
    await store.gravarDados({ ...config, licoes, avLicoes });
  } catch (erro) {
    console.warn(
      'âš ï¸  Banco configurado, mas nÃ£o consegui gravar as liÃ§Ãµes:',
      erro instanceof Error ? erro.message : erro,
      '\n   Se falar de "relation ... does not exist", rode o supabase/schema.sql no SQL Editor do Supabase.'
    );
  }
}

async function carregarLicoes(gravarDepois = true) {
  let dados: any = null;
  try {
    dados = await store.lerDados();
  } catch (erro) {
    console.warn('NÃ£o consegui ler as liÃ§Ãµes:', erro instanceof Error ? erro.message : erro);
    await store.copiarParaBak(store.CAMINHO_LICOES);
    if (licoes.length) return; // mantÃ©m o que jÃ¡ estÃ¡ em memÃ³ria
    licoes = LICOES_INICIAIS.map(l => ({ ...l }));
    if (avLicoes.length === 0) avLicoes = AV_INICIAIS.map(a => ({ ...a }));
    return;
  }

  if (!dados) {
    // primeira execuÃ§Ã£o (ou banco vazio): cria a estrutura inicial
    licoes = LICOES_INICIAIS.map(l => ({ ...l }));
    if (avLicoes.length === 0) avLicoes = AV_INICIAIS.map(a => ({ ...a }));
    await gravarLicoesSeguro(gravarDepois);
    return;
  }

  const lista = (Array.isArray(dados) ? dados : dados.licoes) as Licao[]; // aceita o formato antigo (sÃ³ a lista)
  if (Array.isArray(lista) && lista.length > 0) licoes = lista.sort((a, b) => a.numero - b.numero);
  else licoes = LICOES_INICIAIS.map(l => ({ ...l }));

  if (!Array.isArray(dados)) {
    const padrao = SchemaPontuacao.safeParse(dados.padrao);
    config = {
      modo: dados.modo === 'todas' ? 'todas' : 'manual',
      padrao: padrao.success ? (padrao.data as Pontuacao) : config.padrao,
      avAutomatico: dados.avAutomatico === true
    };
    if (Array.isArray(dados.avLicoes) && dados.avLicoes.length > 0) {
      avLicoes = (dados.avLicoes as AvLicao[]).sort((a, b) => a.numero - b.numero);
    }
  }
  if (avLicoes.length === 0) avLicoes = AV_INICIAIS.map(a => ({ ...a }));
  await gravarLicoesSeguro(gravarDepois);
}

async function carregarPerfis() {
  try {
    const dados = await store.lerPerfis();
    const todos = Array.isArray(dados) ? (dados as Perfil[]) : [];
    todos.forEach(ajustarPerfil);
    // separa ativos e lixeira: o resto do sistema sÃ³ enxerga os ativos
    perfis = todos.filter(p => !p.excluidoEm);
    lixeira = todos.filter(p => p.excluidoEm);
    await limparLixeiraExpirada();
  } catch (erro) {
    // Falha de leitura NÃƒO pode esvaziar a memÃ³ria: se jÃ¡ temos perfis
    // carregados, seguimos com eles (senÃ£o o aluno "desaparece" por 15 s).
    console.warn(
      'NÃ£o consegui ler os perfis, mantendo os que jÃ¡ estavam em memÃ³ria:',
      erro instanceof Error ? erro.message : erro
    );
    await store.copiarParaBak(store.CAMINHO_PERFIS);
  }
  perfis.forEach(ajustarPerfil);
}

/** Apaga de vez o que passou de DIAS_LIXEIRA na lixeira (roda ao carregar). */
async function limparLixeiraExpirada(): Promise<void> {
  const limite = Date.now() - DIAS_LIXEIRA * 86400000;
  const expirados = lixeira.filter(p => p.excluidoEm && new Date(p.excluidoEm).getTime() < limite);
  if (!expirados.length) return;
  lixeira = lixeira.filter(p => !expirados.includes(p));
  for (const p of expirados) {
    try {
      await store.apagarPerfil(p.id);
    } catch (erro) {
      console.warn('NÃ£o consegui apagar o perfil expirado:', erro instanceof Error ? erro.message : erro);
    }
  }
  await salvar();
}

/** Grava tudo em fila: uma gravaÃ§Ã£o por vez, sem correr risco de perder dados. */
function salvar(): Promise<void> {
  fila = fila
    .then(async () => {
      // a lixeira tambÃ©m Ã© persistida: nada se perde ao reiniciar a instÃ¢ncia
      await store.sincronizarPerfis([...perfis, ...lixeira]);
      await store.gravarDados({ ...config, licoes, avLicoes });
      // cÃ³pia de seguranÃ§a de tempo em tempo (nÃ£o trava e nÃ£o bloqueia a resposta)
      backupRotativo().catch(() => {});
    })
    .catch(e => console.error('Erro ao salvar:', e));
  return fila;
}

const resumo = (p: Perfil) => ({
  id: p.id, nome: p.nome, cor: p.cor, nivel: p.nivel, etapa: p.etapa, trilha: p.trilha, avNivel: p.av.nivel, licoes: p.historico.length, totalLicoes: licoes.length
});
const SchemaNovoPerfil = z.object({ nome: z.string().trim().min(1).max(20), cor: z.enum(CORES_PERFIL) });

app.get('/api/perfis', (_req, res) => res.json(perfis.map(resumo)));

app.post('/api/perfis', async (req, res) => {
  const r = SchemaNovoPerfil.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Nome ou cor invÃ¡lidos.' });
  const p = novoPerfil(r.data.nome, r.data.cor);
  perfis.push(p);
  await salvar();
  res.status(201).json(resumo(p));
});

// ---------------------------------------------------------------------------
// Lixeira: excluir manda o perfil para a lixeira por DIAS_LIXEIRA dias.
// Nada Ã© apagado de verdade nesse perÃ­odo â€” dÃ¡ para restaurar.
// ---------------------------------------------------------------------------
const infoLixeira = (p: Perfil) => ({
  id: p.id,
  nome: p.nome,
  cor: p.cor,
  nivel: p.nivel,
  licoes: p.historico.length,
  excluidoEm: p.excluidoEm || null,
  diasRestantes: p.excluidoEm
    ? Math.max(0, DIAS_LIXEIRA - Math.floor((Date.now() - new Date(p.excluidoEm).getTime()) / 86400000))
    : DIAS_LIXEIRA
});

app.get('/api/lixeira', (_req, res) => {
  res.json({ dias: DIAS_LIXEIRA, total: lixeira.length, perfis: lixeira.map(infoLixeira) });
});

app.post('/api/perfil-restaurar', exigirAdmin, async (req, res) => {
  const corpo = (req.body || {}) as Record<string, any>;
  const id = String(corpo.perfilId || req.query.perfilId || '');
  const i = lixeira.findIndex(p => p.id === id);
  if (i < 0) return res.status(404).json({ erro: 'Esse perfil nÃ£o estÃ¡ na lixeira.' });
  const [p] = lixeira.splice(i, 1);
  p.excluidoEm = null;
  perfis.push(p);
  await salvar();
  res.json({ sucesso: true, perfil: resumo(p) });
});

app.delete('/api/lixeira', exigirAdmin, async (req, res) => {
  const id = String(req.query.id || '');
  const i = lixeira.findIndex(p => p.id === id);
  if (i < 0) return res.status(404).json({ erro: 'Esse perfil nÃ£o estÃ¡ na lixeira.' });
  lixeira.splice(i, 1);
  try {
    await store.apagarPerfil(id);
  } catch (erro) {
    console.warn('NÃ£o consegui apagar de vez no banco:', erro instanceof Error ? erro.message : erro);
  }
  await salvar();
  res.json({ sucesso: true });
});

app.get('/api/perfis/:id', async (req, res) => {
  let p = perfis.find(x => x.id === req.params.id);
  if (!p) {
    // Cada instÃ¢ncia (lambda) tem a sua memÃ³ria. Se o perfil nÃ£o estÃ¡ aqui,
    // pode ter sido criado/alterado em outra instÃ¢ncia: relÃª do banco uma vez.
    try {
      await carregarPerfis();
    } catch {
      /* segue com o que jÃ¡ tem em memÃ³ria */
    }
    p = perfis.find(x => x.id === req.params.id);
  }
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  res.json(p);
});

// Excluir NÃƒO apaga: manda para a lixeira (restaurÃ¡vel por DIAS_LIXEIRA dias).
app.delete('/api/perfis/:id', exigirAdmin, async (req, res) => {
  const i = perfis.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  const [p] = perfis.splice(i, 1);
  p.excluidoEm = new Date().toISOString();
  lixeira.unshift(p);
  await salvar();
  res.json({ sucesso: true, lixeira: true, dias: DIAS_LIXEIRA });
});

function treinoDo(p?: Perfil): Treino | undefined {
  if (!p) return undefined;
  return {
    teclas: Object.fromEntries(Object.entries(p.fracas).map(([k, f]) => [k, f.peso])),
    pares: Object.keys(p.fracasPares)
  };
}

/** Teclas em treino, com a informaÃ§Ã£o se aparecem na etapa em que o aluno estÃ¡. */
function listaFracas(p: Perfil, pos: Pos) {
  const naEtapa = letrasDaEtapa(pos.trilha, pos.nivel, pos.etapa);
  return Object.entries(p.fracas)
    .map(([tecla, f]) => ({ tecla, semErro: f.semErro, peso: f.peso, nestaEtapa: naEtapa.has(tecla) }))
    .sort((a, b) => b.peso - a.peso);
}

function montarExercicio(pos: Pos, perfil?: Perfil) {
  const v = vistaDa(pos.trilha, pos.nivel) ?? vistaDa('l', 1)!;
  const trilha: TrilhaId = vistaDa(pos.trilha, pos.nivel) ? pos.trilha : 'l';
  const total = etapasDa(trilha, v.numero).length;
  const e = Math.min(Math.max(pos.etapa, 1), total);
  return {
    trilha,
    nivel: v.numero,
    etapa: e,
    totalEtapas: total,
    titulo: rotuloPosicao(trilha, v.numero, e),
    textoAlvo: gerarTexto(trilha, v.numero, e, treinoDo(perfil)),
    meta: { precisaoMin: v.precisaoMin, wpmMin: v.wpmMin },
    fracas: perfil ? listaFracas(perfil, { trilha, nivel: v.numero, etapa: e }) : [],
    perfeitosSeguidos: perfil?.perfeitosSeguidos ?? 0
  };
}

app.get('/api/iniciar', async (req, res) => {
  let perfil = perfis.find(p => p.id === req.query.perfil);
  if (!perfil && req.query.perfil) {
    // mesma proteÃ§Ã£o: instÃ¢ncia diferente pode nÃ£o ter o perfil em memÃ³ria
    try {
      await carregarPerfis();
    } catch {
      /* segue com o que jÃ¡ tem */
    }
    perfil = perfis.find(p => p.id === req.query.perfil);
  }
  if (!perfil && req.query.perfil) {
    // id informado e nÃ£o existe (ou estÃ¡ na lixeira): avisa em vez de cair na liÃ§Ã£o 1
    return res.status(404).json({ erro: 'Perfil nÃ£o encontrado â€” ele pode estar na lixeira.' });
  }
  if (perfil) ajustarPerfil(perfil);
  const exercicio = montarExercicio(perfil ? posDe(perfil) : { trilha: 'l', nivel: 1, etapa: 1 }, perfil);
  res.json({ ...exercicio, painel: perfil ? painelDe(perfil) : null });
});

// ---------------------------------------------------------------------------
// LiÃ§Ãµes: listar, criar, ajustar pontuaÃ§Ã£o, excluir, escolher qual treinar
// ---------------------------------------------------------------------------
app.get('/api/licoes', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (p) ajustarPerfil(p);
  res.json({
    modo: config.modo,
    padrao: config.padrao,
    licoes: licoes.map(l => ({
      numero: l.numero,
      titulo: tituloCompleto(l),
      letras: l.letras,
      precisaoMin: l.precisaoMin,
      wpmMin: l.wpmMin,
      fixa: l.fixa,
      etapas: etapasDa('l', l.numero).map(t => NOME_ETAPA[t]),
      status: !p ? 'bloqueada' : l.numero <= p.concluidaAte ? 'concluida' : l.numero === p.concluidaAte + 1 ? 'andamento' : 'bloqueada',
      atual: !!p && p.trilha === 'l' && p.nivel === l.numero,
      etapaAtual: p && p.trilha === 'l' && p.nivel === l.numero ? p.etapa : null
    }))
  });
});

const SchemaPontuacao = z.object({
  precisaoMin: z.number().int().min(50).max(100),
  wpmMin: z.number().int().min(0).max(150)
});
const SchemaNovaLicao = SchemaPontuacao.partial().extend({ letras: z.string().max(40) });

app.post('/api/licoes', exigirAdmin, async (req, res) => {
  const r = SchemaNovaLicao.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Dados invÃ¡lidos.' });
  if (licoes.length >= MAX_LICOES) return res.status(400).json({ erro: 'Limite de liÃ§Ãµes atingido.' });

  const letras = [...new Set(r.data.letras.toLowerCase().replace(/[\s,;.\-]+/g, ''))].join('');
  if (!/^[a-z]{2,10}$/.test(letras)) {
    return res.status(400).json({ erro: 'Use de 2 a 10 letras de A a Z, sem acentos.' });
  }
  const numero = licoes.length + 1;
  const nova: Licao = {
    numero,
    titulo: `Teclas ${[...letras].map(c => c.toUpperCase()).join(' ')}`,
    letras,
    precisaoMin: config.modo === 'todas' ? config.padrao.precisaoMin : (r.data.precisaoMin ?? PRECISAO_PADRAO),
    wpmMin: config.modo === 'todas' ? config.padrao.wpmMin : (r.data.wpmMin ?? WPM_PADRAO_NOVA),
    fixa: false
  };
  licoes.push(nova);
  await salvar();
  res.status(201).json({ numero, etapas: etapasDa('l', numero).map(t => NOME_ETAPA[t]) });
});

app.put('/api/licoes/:n/pontuacao', exigirAdmin, async (req, res) => {
  const l = licaoPor(Number(req.params.n));
  const r = SchemaPontuacao.safeParse(req.body);
  if (!l) return res.status(404).json({ erro: 'LiÃ§Ã£o nÃ£o encontrada.' });
  if (config.modo === 'todas') return res.status(400).json({ erro: 'O modo "Todas as liÃ§Ãµes" estÃ¡ ligado. Troque para Manual para editar uma liÃ§Ã£o.' });
  if (!r.success) return res.status(400).json({ erro: 'PrecisÃ£o de 50 a 100 e velocidade de 0 a 150.' });
  l.precisaoMin = r.data.precisaoMin;
  l.wpmMin = r.data.wpmMin;
  await salvar();
  res.json({ sucesso: true });
});

/** Liga/desliga o modo "Todas as liÃ§Ãµes" e define o valor global (que tambÃ©m vale para liÃ§Ãµes novas). */
const SchemaConfigPontuacao = z.object({ modo: z.enum(['todas', 'manual']), padrao: SchemaPontuacao.optional() });
app.put('/api/config/pontuacao', exigirAdmin, async (req, res) => {
  const r = SchemaConfigPontuacao.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'PrecisÃ£o de 50 a 100 e velocidade de 0 a 150.' });
  if (r.data.padrao) config.padrao = r.data.padrao as Pontuacao;
  config.modo = r.data.modo;
  if (config.modo === 'todas') {
    for (const l of licoes) {
      l.precisaoMin = config.padrao.precisaoMin;
      l.wpmMin = config.padrao.wpmMin;
    }
  }
  await salvar();
  res.json({ modo: config.modo, padrao: config.padrao });
});

app.delete('/api/licoes/:n', exigirAdmin, async (req, res) => {
  const n = Number(req.params.n);
  const l = licaoPor(n);
  if (!l) return res.status(404).json({ erro: 'LiÃ§Ã£o nÃ£o encontrada.' });
  if (l.fixa) return res.status(400).json({ erro: 'As liÃ§Ãµes 1 a 4 nÃ£o podem ser excluÃ­das.' });
  if (n !== licoes.length) return res.status(400).json({ erro: 'SÃ³ dÃ¡ para excluir a Ãºltima liÃ§Ã£o.' });
  licoes.pop();
  perfis.forEach(ajustarPerfil);
  await salvar();
  res.json({ sucesso: true });
});

const SchemaTreinar = z.object({ licao: z.number().int().min(1), trilha: z.enum(['l', 'a']).optional() });
app.post('/api/perfis/:id/treinar', async (req, res) => {
  const p = perfis.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const r = SchemaTreinar.safeParse(req.body);
  const trilha: TrilhaId = r.success ? (r.data.trilha ?? 'l') : 'l';
  if (!r.success || !vistaDa(trilha, r.data.licao)) return res.status(400).json({ erro: 'LiÃ§Ã£o invÃ¡lida.' });
  if (trilha === 'a') {
    if (p.concluidaAte < LIBERA_AVANCADO) return res.status(400).json({ erro: `O AvanÃ§ado abre depois de concluir a liÃ§Ã£o ${LIBERA_AVANCADO}.` });
    if (r.data.licao > p.av.concluidaAte + 1) return res.status(400).json({ erro: 'Essa liÃ§Ã£o ainda estÃ¡ bloqueada.' });
  } else if (r.data.licao > p.concluidaAte + 1) {
    return res.status(400).json({ erro: 'Essa liÃ§Ã£o ainda estÃ¡ bloqueada.' });
  }
  definirPos(p, { trilha, nivel: r.data.licao, etapa: 1 });
  p.tentativasEtapa = 0;
  await salvar();
  res.json({ sucesso: true });
});

app.post('/api/perfis/:id/voltar-etapa', async (req, res) => {
  const p = perfis.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const ant = posicaoAnterior(posDe(p));
  if (!ant) return res.status(400).json({ erro: 'NÃ£o hÃ¡ etapa anterior.' });
  definirPos(p, ant);
  p.tentativasEtapa = 0;
  ajustarPerfil(p);
  await salvar();
  res.json({ sucesso: true });
});

// ---------------------------------------------------------------------------
// AvanÃ§ado: abre depois da liÃ§Ã£o 5; liÃ§Ãµes criadas pelo sistema (ou manualmente)
// ---------------------------------------------------------------------------
function statusAv(p: Perfil | undefined, n: number): 'concluida' | 'andamento' | 'bloqueada' {
  if (!p || p.concluidaAte < LIBERA_AVANCADO) return 'bloqueada';
  return n <= p.av.concluidaAte ? 'concluida' : n === p.av.concluidaAte + 1 ? 'andamento' : 'bloqueada';
}

app.get('/api/avancado', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (p) ajustarPerfil(p);
  res.json({
    liberado: !!p && p.concluidaAte >= LIBERA_AVANCADO,
    liberaApos: LIBERA_AVANCADO,
    automatico: config.avAutomatico,
    licoes: avLicoes.map(a => ({
      numero: a.numero,
      titulo: avTitulo(a.numero),
      escopo: avEscopoTexto(a.numero),
      etapas: etapasDa('a', a.numero).map(t => NOME_ETAPA[t]),
      precisaoMin: a.precisaoMin,
      wpmMin: a.wpmMin,
      auto: a.auto,
      status: statusAv(p, a.numero),
      atual: !!p && p.trilha === 'a' && p.av.nivel === a.numero,
      etapaAtual: p && p.trilha === 'a' && p.av.nivel === a.numero ? p.av.etapa : null
    }))
  });
});

app.put('/api/avancado/automatico', exigirAdmin, async (req, res) => {
  const r = z.object({ automatico: z.boolean() }).safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Dados invÃ¡lidos.' });
  config.avAutomatico = r.data.automatico;
  await salvar();
  res.json({ automatico: config.avAutomatico });
});

app.post('/api/avancado/licoes', exigirAdmin, async (_req, res) => {
  if (avLicoes.length >= MAX_LICOES) return res.status(400).json({ erro: 'Limite de liÃ§Ãµes atingido.' });
  const nova = novaAvLicao(false);
  avLicoes.push(nova);
  await salvar();
  res.status(201).json({ numero: nova.numero });
});

app.put('/api/avancado/licoes/:n/pontuacao', exigirAdmin, async (req, res) => {
  const a = avLicoes.find(x => x.numero === Number(req.params.n));
  const r = SchemaPontuacao.safeParse(req.body);
  if (!a) return res.status(404).json({ erro: 'LiÃ§Ã£o nÃ£o encontrada.' });
  if (!r.success) return res.status(400).json({ erro: 'PrecisÃ£o de 50 a 100 e velocidade de 0 a 150.' });
  a.precisaoMin = r.data.precisaoMin;
  a.wpmMin = r.data.wpmMin;
  await salvar();
  res.json({ sucesso: true });
});

// ---------------------------------------------------------------------------
// Entrada (validada com zod)
// ---------------------------------------------------------------------------
const SchemaEvento = z.object({
  teclaEsperada: z.string(),
  teclaDigitada: z.string(),
  correta: z.boolean(),
  tempoMs: z.number()
});

const SchemaSubmissao = z.object({
  perfilId: z.string(),
  nivelAtual: z.number().int().optional(), // ignorado: vale a posiÃ§Ã£o salva no servidor
  tempoTotalSegundos: z.number(),
  comboMax: z.number().int().min(0).max(100000).optional(),
  id: z.string().max(64).optional(), // identificador do envio (evita contar duas vezes)
  eventosTeclas: z.array(SchemaEvento).min(1)
});

// ---------------------------------------------------------------------------
// AnÃ¡lise por tecla (conta exata, feita no cÃ³digo)
// ---------------------------------------------------------------------------
type StatTecla = { tecla: string; tentativas: number; erros: number; tempoMedioMs: number };

function analisarTeclas(eventos: z.infer<typeof SchemaEvento>[]): StatTecla[] {
  const mapa = new Map<string, { tentativas: number; erros: number; somaTempo: number; contTempo: number }>();

  eventos.forEach((e, i) => {
    const tecla = e.teclaEsperada.toLowerCase();
    if (tecla === ' ') return;
    const s = mapa.get(tecla) ?? { tentativas: 0, erros: 0, somaTempo: 0, contTempo: 0 };
    s.tentativas++;
    if (!e.correta) s.erros++;
    if (i > 0) {
      // o primeiro evento nÃ£o tem tempo vÃ¡lido (relÃ³gio comeÃ§a nele)
      s.somaTempo += e.tempoMs;
      s.contTempo++;
    }
    mapa.set(tecla, s);
  });

  return [...mapa.entries()].map(([tecla, s]) => ({
    tecla,
    tentativas: s.tentativas,
    erros: s.erros,
    tempoMedioMs: s.contTempo > 0 ? Math.round(s.somaTempo / s.contTempo) : 0
  }));
}

/** Tecla fraca = mais erros; empate â†’ a mais lenta. Sem erros, nÃ£o hÃ¡ tecla fraca. */
function acharTeclaFraca(stats: StatTecla[]): string | null {
  const comErro = stats.filter(s => s.erros > 0);
  if (comErro.length === 0) return null;
  comErro.sort((a, b) => b.erros - a.erros || b.tempoMedioMs - a.tempoMedioMs);
  return comErro[0].tecla;
}

/** Conta as trocas "esperada>digitada" (ex: "Ã§>l" quando digitou L no lugar de Ã‡). */
function contarPares(eventos: z.infer<typeof SchemaEvento>[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of eventos) {
    if (e.correta) continue;
    const a = e.teclaEsperada.toLowerCase();
    const b = e.teclaDigitada.toLowerCase();
    if (a === ' ' || b.length !== 1 || b === ' ' || a === b) continue;
    m[`${a}>${b}`] = (m[`${a}>${b}`] ?? 0) + 1;
  }
  return m;
}

/**
 * Teclas com 2+ erros entram (ou ficam) na lista de treino; saem depois de
 * 3 exercÃ­cios seguidos sem erro nelas. SÃ³ conta quando a tecla apareceu no exercÃ­cio.
 * Os pares confundidos seguem a mesma regra.
 */
function atualizarFracas(p: Perfil, stats: StatTecla[], pares: Record<string, number>) {
  for (const s of stats) {
    const atual = p.fracas[s.tecla];
    if (s.erros >= MIN_ERROS_FRACA) {
      p.fracas[s.tecla] = { semErro: 0, peso: s.erros };
    } else if (atual) {
      if (s.erros === 0) {
        atual.semErro++;
        if (atual.semErro >= LIMPAS_PARA_SAIR) delete p.fracas[s.tecla];
      } else {
        atual.semErro = 0;
      }
    }
  }

  const apareceu = new Set(stats.map(s => s.tecla));
  for (const [par, qtd] of Object.entries(pares)) {
    if (qtd >= MIN_ERROS_FRACA) p.fracasPares[par] = { semErro: 0, peso: qtd };
  }
  for (const [par, f] of Object.entries(p.fracasPares)) {
    const qtd = pares[par] ?? 0;
    if (qtd >= MIN_ERROS_FRACA || !apareceu.has(par.split('>')[0])) continue;
    if (qtd === 0) {
      f.semErro++;
      if (f.semErro >= LIMPAS_PARA_SAIR) delete p.fracasPares[par];
    } else {
      f.semErro = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Jev (TypeSafe AI): decisÃµes tipadas
// ---------------------------------------------------------------------------
type Acao = 'avancar' | 'repetir' | 'reforcar' | 'voltar';

const SchemaNoul = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });

const SchemaRespostaJev = z.object({
  answers: z.object({
    domina: SchemaNoul,
    dificuldade: SchemaNoul,
    fluencia: z.object({
      type: z.literal('score'),
      score: z.number().min(0).max(2),
      confidence: z.number().min(0).max(1)
    })
  })
});

type DecisaoJev = {
  domina: number; // probabilidade de 0 a 1
  dificuldade: number; // probabilidade de 0 a 1
  fluencia: number; // 0 = hesitante, 1 = regular, 2 = fluente
};

type ContextoLicao = {
  trilha: TrilhaId;
  nivel: number; // nÃºmero da liÃ§Ã£o
  etapa: number;
  precisao: number;
  wpm: number;
  acertos: number;
  total: number;
  stats: StatTecla[];
  teclaFraca: string | null;
  precisaoMin: number;
  wpmMin: number;
  fracas: { tecla: string; peso: number; semErro: number }[]; // teclas em treino que aparecem nesta etapa
  pares: string[]; // trocas em treino
  tentativas: number; // exercÃ­cios seguidos nesta etapa (contando este)
};

const listar = (teclas: string[]) => {
  const t = teclas.map(k => k.toUpperCase());
  return t.length <= 1 ? t.join('') : `${t.slice(0, -1).join(', ')} e ${t[t.length - 1]}`;
};

function montarEstado(c: ContextoLicao): string {
  const erros = c.total - c.acertos;
  const tempos = c.stats.map(s => `${s.tecla}=${s.tempoMedioMs}ms`).join(', ');
  const errosPorTecla =
    c.stats
      .filter(s => s.erros > 0)
      .map(s => `${s.tecla}=${s.erros}`)
      .join(', ') || 'nenhum';
  const l = licaoPor(c.nivel);
  const letras = c.trilha === 'a' ? `todas as jÃ¡ aprendidas (${avEscopoTexto(c.nivel)}), em palavras e frases do dia a dia` : l ? [...l.letras].join(' ') : '-';

  return [
    `Aluno de um curso de digitaÃ§Ã£o (touch typing), na ${rotuloPosicao(c.trilha, c.nivel, c.etapa)}. Letras: ${letras}.`,
    `Meta definida pelo professor para passar de etapa: precisÃ£o mÃ­nima ${c.precisaoMin}% e ${c.wpmMin} palavras por minuto.`,
    `Resultado do Ãºltimo exercÃ­cio: precisÃ£o ${c.precisao}%, ${c.wpm} palavras por minuto, ${c.acertos} acertos e ${erros} erros em ${c.total} teclas digitadas.`,
    `Tempo mÃ©dio por tecla: ${tempos || 'indisponÃ­vel'}.`,
    `Erros por tecla: ${errosPorTecla}.`,
    `Tecla com mais erros: ${c.teclaFraca ?? 'nenhuma'}.`,
    `Teclas em treino (2+ erros; saem apÃ³s 3 exercÃ­cios seguidos sem erro): ${c.fracas.map(f => `${f.tecla}=${f.peso} erros, ${f.semErro}/3 limpos`).join('; ') || 'nenhuma'}.`,
    `Trocas de teclas em treino: ${c.pares.map(p => p.replace('>', ' no lugar de ')).join('; ') || 'nenhuma'}.`,
    `ExercÃ­cios seguidos nesta etapa: ${c.tentativas}.`
  ].join('\n');
}

async function consultarJev(c: ContextoLicao): Promise<DecisaoJev> {
  if (!JEV_API_KEY) throw new Error('JEV_API_KEY nÃ£o configurada');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);

  try {
    const resp = await fetch(JEV_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${JEV_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        state: montarEstado(c),
        model: JEV_MODELO,
        questions: {
          domina: {
            type: 'noul',
            instructions: 'O aluno domina esta etapa: digita com precisÃ£o e ritmo bons o bastante para passar Ã  prÃ³xima?'
          },
          dificuldade: {
            type: 'noul',
            instructions: 'O aluno teve muita dificuldade neste exercÃ­cio: muitos erros e hesitaÃ§Ã£o, a ponto de precisar voltar Ã  etapa anterior?'
          },
          fluencia: {
            type: 'score',
            instructions: 'QuÃ£o fluente Ã© a digitaÃ§Ã£o do aluno neste exercÃ­cio?',
            criteria: [
              'Hesitante: lento, com pausas e erros',
              'Regular: ritmo irregular ou velocidade baixa',
              'Fluente: ritmo constante e preciso'
            ]
          }
        }
      })
    });

    if (!resp.ok) throw new Error(`Jev respondeu HTTP ${resp.status}`);

    const json = SchemaRespostaJev.parse(await resp.json());
    return {
      domina: json.answers.domina.noul,
      dificuldade: json.answers.dificuldade.noul,
      fluencia: json.answers.fluencia.score
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// DecisÃ£o final (as respostas do Jev sÃ£o combinadas aqui, no cÃ³digo)
// A meta de pontuaÃ§Ã£o da liÃ§Ã£o (definida por vocÃª) Ã© um piso: o Jev nunca
// libera quem ficou abaixo dela, mas pode segurar quem passou nela.
// ---------------------------------------------------------------------------
type Veredito = {
  acao: Acao;
  motivo: string; // mensagem usada quando NÃƒO avanÃ§a
  decididoPor: 'jev' | 'regra';
  confianca: number | null;
  fluencia: number | null;
};

type Decisao = {
  proximoNivel: number;
  proximaEtapa: number;
  acao: Acao;
  mensagem: string;
  decididoPor: 'jev' | 'regra';
  confianca: number | null;
  fluencia: number | null;
  concluiuLicao: boolean;
  concluiuTudo: boolean;
};

const certeza = (p: number) => Math.abs(p - 0.5) * 2;
const atingiuMeta = (c: ContextoLicao) => c.precisao >= c.precisaoMin && c.wpm >= c.wpmMin;
/** Passa de etapa sÃ³ com a meta batida E sem teclas em treino nesta etapa. */
const passou = (c: ContextoLicao) => atingiuMeta(c) && c.fracas.length === 0;

function proximaPosicao(p: Pos): Pos | null {
  if (p.etapa < etapasDa(p.trilha, p.nivel).length) return { ...p, etapa: p.etapa + 1 };
  return vistaDa(p.trilha, p.nivel + 1) ? { trilha: p.trilha, nivel: p.nivel + 1, etapa: 1 } : null;
}

function posicaoAnterior(p: Pos): Pos | null {
  if (p.etapa > 1) return { ...p, etapa: p.etapa - 1 };
  if (p.nivel > 1) return { trilha: p.trilha, nivel: p.nivel - 1, etapa: etapasDa(p.trilha, p.nivel - 1).length };
  return null;
}

function motivoPasso(c: ContextoLicao): string {
  const teclas = listar(c.fracas.map(f => f.tecla));
  if (atingiuMeta(c)) {
    return `Meta batida, mas ainda hÃ¡ teclas em treino: ${teclas}. Cada uma precisa de 3 exercÃ­cios seguidos sem erro (${c.fracas.map(f => `${f.tecla.toUpperCase()} ${f.semErro}/3`).join(', ')}).`;
  }
  const faltas: string[] = [];
  if (c.precisao < c.precisaoMin) faltas.push(`precisÃ£o ${c.precisao}% (meta ${c.precisaoMin}%)`);
  if (c.wpm < c.wpmMin) faltas.push(`velocidade ${c.wpm} palavras por minuto (meta ${c.wpmMin})`);
  const extra = c.fracas.length ? ` Treine tambÃ©m ${teclas}.` : '';
  return `Ainda falta chegar na meta: ${faltas.join(' e ')}.${extra} Vamos praticar mais uma sequÃªncia.`;
}

function decidirPorRegra(c: ContextoLicao): Veredito {
  const base = { decididoPor: 'regra' as const, confianca: null, fluencia: null };
  if (passou(c)) return { ...base, acao: 'avancar', motivo: '' };
  return { ...base, acao: 'repetir', motivo: motivoPasso(c) };
}

/** Combina as respostas do Jev. Devolve null quando o Jev nÃ£o tem certeza. */
function combinarJev(c: ContextoLicao, j: DecisaoJev): Veredito | null {
  const base = { decididoPor: 'jev' as const, fluencia: j.fluencia };
  const meta = passou(c);

  // 1) Muita dificuldade e abaixo da meta â†’ voltar (sÃ³ se existir etapa anterior)
  if (j.dificuldade >= LIMIAR_DIFICULDADE && !atingiuMeta(c) && posicaoAnterior({ trilha: c.trilha, nivel: c.nivel, etapa: c.etapa })) {
    return { ...base, acao: 'voltar', confianca: certeza(j.dificuldade), motivo: '' };
  }

  // 2) DomÃ­nio com certeza suficiente
  if (certeza(j.domina) >= CERTEZA_MINIMA) {
    const confianca = certeza(j.domina);
    const domina = j.domina > 0.5;

    if (domina && meta) return { ...base, acao: 'avancar', confianca, motivo: '' };
    if (domina && !meta) return { ...base, acao: 'repetir', confianca, motivo: motivoPasso(c) };
    const alvo = c.fracas.length ? c.fracas.map(f => f.tecla) : c.teclaFraca ? [c.teclaFraca] : [];
    if (alvo.length) {
      return { ...base, acao: 'reforcar', confianca, motivo: `Vamos treinar mais: ${listar(alvo)}, onde vocÃª mais errou.` };
    }
    return { ...base, acao: 'repetir', confianca, motivo: 'Bom trabalho! Mais uma sequÃªncia para fixar.' };
  }

  return null; // Jev em dÃºvida
}

/** Transforma o veredito (avanÃ§ar, repetir...) na posiÃ§Ã£o seguinte e na mensagem. */
function resolver(c: ContextoLicao, v: Veredito): Decisao {
  const aqui: Pos = { trilha: c.trilha, nivel: c.nivel, etapa: c.etapa };
  let pos = aqui;
  let acao = v.acao;
  let mensagem = v.motivo;
  let concluiuLicao = false;
  let concluiuTudo = false;

  if (acao === 'avancar') {
    const prox = proximaPosicao(aqui);
    if (!prox) {
      concluiuLicao = true;
      concluiuTudo = true;
      mensagem = c.trilha === 'a'
        ? 'ParabÃ©ns! VocÃª concluiu todas as liÃ§Ãµes avanÃ§adas disponÃ­veis. Ligue "Adicionar automaticamente" ou adicione uma nova na aba AvanÃ§ado.'
        : 'ParabÃ©ns! VocÃª concluiu todas as liÃ§Ãµes disponÃ­veis. Crie uma nova na aba LiÃ§Ãµes para continuar.';
    } else {
      pos = prox;
      concluiuLicao = prox.nivel !== aqui.nivel;
      mensagem = concluiuLicao
        ? `LiÃ§Ã£o concluÃ­da! AvanÃ§ou para ${vistaDa(prox.trilha, prox.nivel)?.titulo ?? 'a prÃ³xima liÃ§Ã£o'}`
        : `Excelente! PrÃ³xima etapa: ${NOME_ETAPA[tipoDaEtapa(prox.trilha, prox.nivel, prox.etapa)]}`;
    }
  } else if (acao === 'voltar') {
    const ant = posicaoAnterior(aqui);
    if (ant) {
      pos = ant;
      mensagem = `Vamos reforÃ§ar a base: voltando para ${rotuloPosicao(ant.trilha, ant.nivel, ant.etapa)}`;
    } else {
      acao = 'repetir';
    }
  }

  return {
    proximoNivel: pos.nivel, proximaEtapa: pos.etapa, acao, mensagem,
    decididoPor: v.decididoPor, confianca: v.confianca, fluencia: v.fluencia, concluiuLicao, concluiuTudo
  };
}

async function decidir(c: ContextoLicao): Promise<Decisao> {
  try {
    const jev = await consultarJev(c);
    const v = combinarJev(c, jev);
    const resumoJev = `domina=${jev.domina.toFixed(2)} dificuldade=${jev.dificuldade.toFixed(2)} fluÃªncia=${jev.fluencia.toFixed(2)}`;
    if (!v) {
      console.log(`[Jev] ${resumoJev} â†’ sem certeza, usando regra fixa`);
      return resolver(c, decidirPorRegra(c));
    }
    const d = resolver(c, v);
    console.log(`[Jev] ${resumoJev} â†’ aÃ§Ã£o=${d.acao} (certeza ${v.confianca?.toFixed(2)}) â†’ liÃ§Ã£o ${d.proximoNivel} etapa ${d.proximaEtapa}`);
    return d;
  } catch (erro) {
    console.warn('[Jev] indisponÃ­vel, usando regra fixa:', erro instanceof Error ? erro.message : erro);
    return resolver(c, decidirPorRegra(c));
  }
}

// ---------------------------------------------------------------------------
// AvaliaÃ§Ã£o do exercÃ­cio
// ---------------------------------------------------------------------------
app.post('/api/avaliar-licao', async (req, res) => {
  const parsed = SchemaSubmissao.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ erro: 'Dados enviados invÃ¡lidos.' });
  }
  const dados = parsed.data;
  const perfil = perfis.find(p => p.id === dados.perfilId);
  if (!perfil) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(perfil);
  const aqui = posDe(perfil);

  // AvanÃ§ado em modo automÃ¡tico: garante que existe uma liÃ§Ã£o depois da Ãºltima, antes de decidir
  if (aqui.trilha === 'a' && config.avAutomatico && aqui.nivel === avLicoes.length && avLicoes.length < MAX_LICOES) {
    avLicoes.push(novaAvLicao(true));
  }
  const licao = vistaDa(aqui.trilha, aqui.nivel);
  if (!licao) return res.status(500).json({ erro: 'LiÃ§Ã£o atual nÃ£o encontrada.' });

  const acertos = dados.eventosTeclas.filter(e => e.correta).length;
  const total = dados.eventosTeclas.length;
  const precisao = Math.round((acertos / total) * 100);
  const minutos = dados.tempoTotalSegundos / 60;
  const wpm = minutos > 0 ? Math.round(acertos / 5 / minutos) : 0;

  const stats = analisarTeclas(dados.eventosTeclas);
  const teclaFraca = acharTeclaFraca(stats);

  // Reenvio da fila local (servidor caiu no meio): nÃ£o conta duas vezes
  if (jaProcessado(perfil, dados.id)) {
    const posDup = posDe(perfil);
    const proxDup = montarExercicio(posDup, perfil);
    const licaoDup = vistaDa(posDup.trilha, posDup.nivel);
    return res.json({
      sucesso: true,
      duplicado: true,
      relatorio: {
        wpm,
        precisao,
        mensagemFeedback: 'Este exercÃ­cio jÃ¡ tinha sido registrado. Continuando de onde vocÃª parou.',
        proximoNivel: proxDup.nivel,
        proximaEtapa: proxDup.etapa,
        trilha: proxDup.trilha,
        tituloNivel: proxDup.titulo,
        proximoTextoAlvo: proxDup.textoAlvo,
        metaAtual: { precisaoMin: licaoDup ? licaoDup.precisaoMin : 0, wpmMin: licaoDup ? licaoDup.wpmMin : 0 },
        metaAtingida: !!licaoDup && precisao >= licaoDup.precisaoMin && wpm >= licaoDup.wpmMin,
        concluiuLicao: false,
        concluiuTudo: false,
        avancadoLiberado: false,
        decididoPor: 'regra',
        confianca: null,
        fluencia: null,
        teclaFraca,
        fracas: proxDup.fracas,
        perfeitosSeguidos: perfil.perfeitosSeguidos,
        sugestao: null
      },
      painel: painelDe(perfil),
      novosRecordes: [],
      conquistasNovas: []
    });
  }

  // Atualiza a lista de teclas em treino ANTES de decidir (a tecla pode sair da lista neste exercÃ­cio)
  atualizarFracas(perfil, stats, contarPares(dados.eventosTeclas));
  const fracasAqui = listaFracas(perfil, aqui).filter(f => f.nestaEtapa);
  const naEtapa = letrasDaEtapa(aqui.trilha, aqui.nivel, aqui.etapa);

  const contexto: ContextoLicao = {
    trilha: aqui.trilha, nivel: aqui.nivel, etapa: aqui.etapa, precisao, wpm, acertos, total, stats, teclaFraca,
    precisaoMin: licao.precisaoMin, wpmMin: licao.wpmMin,
    fracas: fracasAqui.map(f => ({ tecla: f.tecla, peso: f.peso, semErro: f.semErro })),
    pares: Object.keys(perfil.fracasPares).filter(par => par.split('>').every(t => naEtapa.has(t))),
    tentativas: perfil.tentativasEtapa + 1
  };
  const metaAtingida = atingiuMeta(contexto);
  const decisao = await decidir(contexto);

  // Salva o progresso no perfil
  const novaPos: Pos = { trilha: aqui.trilha, nivel: decisao.proximoNivel, etapa: decisao.proximaEtapa };
  let avancadoLiberado = false;
  if (decisao.acao === 'avancar' && decisao.concluiuLicao) {
    if (aqui.trilha === 'l') {
      const antes = perfil.concluidaAte;
      perfil.concluidaAte = Math.max(antes, aqui.nivel);
      avancadoLiberado = antes < LIBERA_AVANCADO && perfil.concluidaAte >= LIBERA_AVANCADO;
    } else {
      perfil.av.concluidaAte = Math.max(perfil.av.concluidaAte, aqui.nivel);
    }
  }
  definirPos(perfil, novaPos);
  const mudouDeEtapa = novaPos.nivel !== aqui.nivel || novaPos.etapa !== aqui.etapa;
  perfil.tentativasEtapa = mudouDeEtapa ? 0 : perfil.tentativasEtapa + 1;
  perfil.perfeitosSeguidos = precisao === 100 ? perfil.perfeitosSeguidos + 1 : 0;
  perfil.historico.push({
    data: new Date().toISOString(), nivel: aqui.nivel, etapa: aqui.etapa, trilha: aqui.trilha, wpm, precisao, segundos: dados.tempoTotalSegundos,
    decididoPor: decisao.decididoPor, confianca: decisao.confianca, fluencia: decisao.fluencia, teclaFraca
  });
  if (perfil.historico.length > HISTORICO_MAX) perfil.historico.splice(0, perfil.historico.length - HISTORICO_MAX);
  for (const st of stats) {
    const acc = perfil.teclas[st.tecla] ?? { t: 0, e: 0, m: 0, c: 0 };
    acc.t += st.tentativas;
    acc.e += st.erros;
    if (st.tempoMedioMs > 0 && st.tentativas > 1) {
      acc.m = (acc.m ?? 0) + st.tempoMedioMs * (st.tentativas - 1);
      acc.c = (acc.c ?? 0) + (st.tentativas - 1);
    }
    perfil.teclas[st.tecla] = acc;
  }
  registrarAtividade(perfil, dados.tempoTotalSegundos);
  const novosRecordes = atualizarRecordesLicao(perfil, wpm, precisao, dados.comboMax ?? 0);
  const conquistasNovas = verificarConquistas(perfil);
  marcarProcessado(perfil, dados.id);
  ajustarPerfil(perfil);
  await salvar();

  const posAgora = posDe(perfil);
  const proximo = montarExercicio(posAgora, perfil);

  // Travou? Depois de muitos exercÃ­cios na mesma etapa, sugere voltar uma etapa e rever o dedo da tecla
  let sugestao: { tentativas: number; tecla: string | null } | null = null;
  if (!mudouDeEtapa && decisao.acao !== 'avancar' && perfil.tentativasEtapa >= TETO_TENTATIVAS && posicaoAnterior(posAgora)) {
    sugestao = { tentativas: perfil.tentativasEtapa, tecla: proximo.fracas[0]?.tecla ?? teclaFraca };
  }

  res.json({
    sucesso: true,
    relatorio: {
      wpm,
      precisao,
      mensagemFeedback: decisao.mensagem,
      proximoNivel: proximo.nivel,
      proximaEtapa: proximo.etapa,
      trilha: proximo.trilha,
      tituloNivel: proximo.titulo,
      proximoTextoAlvo: proximo.textoAlvo,
      metaAtual: { precisaoMin: licao.precisaoMin, wpmMin: licao.wpmMin },
      metaAtingida,
      concluiuLicao: decisao.concluiuLicao,
      concluiuTudo: decisao.concluiuTudo,
      avancadoLiberado,
      decididoPor: decisao.decididoPor,
      confianca: decisao.confianca,
      fluencia: decisao.fluencia,
      teclaFraca,
      fracas: proximo.fracas,
      perfeitosSeguidos: perfil.perfeitosSeguidos,
      sugestao
    },
    painel: painelDe(perfil),
    novosRecordes,
    conquistasNovas
  });
});

// ===========================================================================
// PAINEL DO ALUNO
// Ofensiva (dias seguidos), meta do dia, revisÃ£o de inatividade, recordes,
// conquistas, testes cronometrados, jogo das palavras, ranking e backups.
// Tudo em cima do mesmo perfis.json â€” nenhuma dependÃªncia nova.
// ===========================================================================

const MIN_LICOES_RANKING = 3; // abaixo disso o perfil aparece como "calibrando"
const HISTORICO_TESTES_MAX = 200;
const HISTORICO_JOGO_MAX = 200;
const IDS_PROCESSADOS_MAX = 80;
const BACKUP_INTERVALO_MS = 10 * 60 * 1000;

type MetaDia = { tipo: 'sessoes' | 'minutos'; valor: number };
type Prefs = {
  diasRevisao: number; // dias sem treinar que disparam a revisÃ£o
  metaDia: MetaDia;
  jogoTamanho: 'normal' | 'grande';
  reduzirMovimento: boolean;
};
type RecordeTeste = { wpm: number; precisao: number; pontos: number; em: string };
type RecordeJogo = { pontos: number; onda: number; combo: number; em: string };
type Recordes = {
  wpm: number;
  wpmEm: string | null;
  precisao: number;
  precisaoEm: string | null;
  combo: number;
  comboEm: string | null;
  teste1min: RecordeTeste | null;
  corrida30s: RecordeTeste | null;
  jogo: RecordeJogo | null;
};
type ResultadoTeste = { data: string; tipo: '1min' | '30s'; wpm: number; precisao: number; pontos: number; segundos: number };
type ResultadoJogo = {
  data: string;
  modalidade: 'classico' | 'precisao' | 'zen';
  pontos: number;
  onda: number;
  combo: number;
  precisao: number;
  palavras: number;
  segundos: number;
};
type Conquista = { id: string; em: string };
type NumeroResultado = { wpm: number; precisao: number; em: string };

const PREFS_PADRAO: Prefs = {
  diasRevisao: 3,
  metaDia: { tipo: 'sessoes', valor: 5 },
  jogoTamanho: 'normal',
  reduzirMovimento: false
};
const RECORDES_ZERADOS: Recordes = {
  wpm: 0, wpmEm: null, precisao: 0, precisaoEm: null, combo: 0, comboEm: null,
  teste1min: null, corrida30s: null, jogo: null
};

const CATALOGO_CONQUISTAS: { id: string; nome: string; desc: string; icone: string }[] = [
  { id: 'primeiro-100', nome: 'Primeiro perfeito', desc: 'Um exercÃ­cio com 100% de precisÃ£o.', icone: 'ðŸŽ¯' },
  { id: 'wpm-20', nome: '20 palavras por minuto', desc: 'AlcanÃ§ou 20 palavras por minuto numa liÃ§Ã£o.', icone: 'ðŸš€' },
  { id: 'wpm-30', nome: '30 palavras por minuto', desc: 'AlcanÃ§ou 30 palavras por minuto numa liÃ§Ã£o.', icone: 'ðŸš€' },
  { id: 'wpm-40', nome: '40 palavras por minuto', desc: 'AlcanÃ§ou 40 palavras por minuto numa liÃ§Ã£o.', icone: 'âš¡' },
  { id: 'wpm-50', nome: '50 palavras por minuto', desc: 'AlcanÃ§ou 50 palavras por minuto numa liÃ§Ã£o.', icone: 'âš¡' },
  { id: 'wpm-60', nome: '60 palavras por minuto', desc: 'AlcanÃ§ou 60 palavras por minuto numa liÃ§Ã£o.', icone: 'ðŸ†' },
  { id: 'ofensiva-3', nome: 'TrÃªs dias seguidos', desc: 'Treinou 3 dias consecutivos.', icone: 'ðŸ”¥' },
  { id: 'ofensiva-7', nome: 'Uma semana inteira', desc: 'Treinou 7 dias consecutivos.', icone: 'ðŸ”¥' },
  { id: 'ofensiva-30', nome: 'Um mÃªs de constÃ¢ncia', desc: 'Treinou 30 dias consecutivos.', icone: 'ðŸ…' },
  { id: 'mil-teclas', nome: 'Mil teclas', desc: 'Digitou 1000 teclas no curso.', icone: 'âŒ¨ï¸' },
  { id: 'teste-1min', nome: 'Teste de 1 minuto', desc: 'Concluiu o teste de 1 minuto.', icone: 'â±ï¸' },
  { id: 'teste-40', nome: '40 no teste', desc: 'Fez 40 palavras por minuto no teste cronometrado.', icone: 'â±ï¸' },
  { id: 'corrida-30s', nome: 'Corrida de 30 segundos', desc: 'Correu contra o prÃ³prio recorde.', icone: 'ðŸ' },
  { id: 'jogo-estreia', nome: 'Primeira defesa', desc: 'Jogou uma partida do jogo das palavras.', icone: 'ðŸ›¡ï¸' },
  { id: 'jogo-onda-5', nome: 'Onda 5', desc: 'Chegou Ã  onda 5 no jogo.', icone: 'ðŸŒŠ' },
  { id: 'jogo-combo-20', nome: 'Combo 20 no jogo', desc: 'Fez 20 acertos seguidos no jogo.', icone: 'ðŸ’¥' },
  { id: 'avancado-liberado', nome: 'AvanÃ§ado liberado', desc: 'Concluiu a liÃ§Ã£o que abre o AvanÃ§ado.', icone: 'ðŸŽ“' },
  { id: 'dez-licoes', nome: 'Dez liÃ§Ãµes', desc: 'Concluiu 10 liÃ§Ãµes de letras.', icone: 'ðŸ“š' }
];

const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const inteiro = (v: unknown, def: number, min: number, max: number): number => Math.round(num(v, def, min, max));

/** Data local no formato AAAA-MM-DD (sem susto de fuso). */
const diaISO = (d = new Date()): string =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const objeto = (v: unknown): Record<string, any> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null;

/** Completa e saneia os campos novos de qualquer perfil (inclusive os antigos). */
function normalizarExtras(p: Perfil) {
  // lixeira: guarda a data sÃ³ se for vÃ¡lida; qualquer outra coisa = ativo
  p.excluidoEm = typeof p.excluidoEm === 'string' && !Number.isNaN(new Date(p.excluidoEm).getTime())
    ? p.excluidoEm
    : null;

  const prefs = objeto(p.prefs) ?? {};
  const meta = objeto(prefs.metaDia) ?? {};
  p.prefs = {
    diasRevisao: inteiro(prefs.diasRevisao, PREFS_PADRAO.diasRevisao, 1, 60),
    metaDia: {
      tipo: meta.tipo === 'minutos' ? 'minutos' : 'sessoes',
      valor: inteiro(meta.valor, PREFS_PADRAO.metaDia.valor, 1, 600)
    },
    jogoTamanho: prefs.jogoTamanho === 'grande' ? 'grande' : 'normal',
    reduzirMovimento: prefs.reduzirMovimento === true
  };

  const r = objeto(p.recordes) ?? {};
  const teste = (v: unknown): RecordeTeste | null => {
    const o = objeto(v);
    if (!o) return null;
    return {
      wpm: inteiro(o.wpm, 0, 0, 400),
      precisao: inteiro(o.precisao, 0, 0, 100),
      pontos: inteiro(o.pontos, 0, 0, 1000000),
      em: typeof o.em === 'string' ? o.em : new Date().toISOString()
    };
  };
  const jogoR = objeto(r.jogo);
  p.recordes = {
    wpm: inteiro(r.wpm, 0, 0, 400),
    wpmEm: typeof r.wpmEm === 'string' ? r.wpmEm : null,
    precisao: inteiro(r.precisao, 0, 0, 100),
    precisaoEm: typeof r.precisaoEm === 'string' ? r.precisaoEm : null,
    combo: inteiro(r.combo, 0, 0, 100000),
    comboEm: typeof r.comboEm === 'string' ? r.comboEm : null,
    teste1min: teste(r.teste1min),
    corrida30s: teste(r.corrida30s),
    jogo: jogoR
      ? {
          pontos: inteiro(jogoR.pontos, 0, 0, 1000000),
          onda: inteiro(jogoR.onda, 1, 1, 9999),
          combo: inteiro(jogoR.combo, 0, 0, 100000),
          em: typeof jogoR.em === 'string' ? jogoR.em : new Date().toISOString()
        }
      : null
  };

  p.atividade = objeto(p.atividade) ?? {};
  p.atividadeMin = objeto(p.atividadeMin) ?? {};
  p.testes = Array.isArray(p.testes) ? p.testes.slice(-HISTORICO_TESTES_MAX) : [];
  p.jogoHistorico = Array.isArray(p.jogoHistorico) ? p.jogoHistorico.slice(-HISTORICO_JOGO_MAX) : [];
  p.conquistas = Array.isArray(p.conquistas) ? p.conquistas.filter(c => c && typeof c.id === 'string') : [];
  p.numeros = objeto(p.numeros) ?? {};
  p.melhorCombo = inteiro(p.melhorCombo, 0, 0, 100000);
  p.idsProcessados = Array.isArray(p.idsProcessados) ? p.idsProcessados.slice(-IDS_PROCESSADOS_MAX) : [];
}

/** Cria um perfil completo jÃ¡ com todos os campos novos. */
function novoPerfil(nome: string, cor: string): Perfil {
  return {
    id: randomUUID(),
    nome,
    cor,
    criadoEm: new Date().toISOString(),
    nivel: 1,
    etapa: 1,
    concluidaAte: 0,
    trilha: 'l',
    av: { nivel: 1, etapa: 1, concluidaAte: 0 },
    fracas: {},
    fracasPares: {},
    tentativasEtapa: 0,
    perfeitosSeguidos: 0,
    historico: [],
    teclas: {},
    prefs: { ...PREFS_PADRAO, metaDia: { ...PREFS_PADRAO.metaDia } },
    recordes: { ...RECORDES_ZERADOS },
    atividade: {},
    atividadeMin: {},
    testes: [],
    jogoHistorico: [],
    conquistas: [],
    numeros: {},
    melhorCombo: 0,
    idsProcessados: []
  };
}

/** SequÃªncia atual e recorde de dias treinados. */
function calcularOfensiva(p: Perfil): { atual: number; recorde: number; ultimo: string | null } {
  const dias = Object.keys(p.atividade ?? {}).filter(d => (p.atividade![d] ?? 0) > 0).sort();
  if (!dias.length) return { atual: 0, recorde: 0, ultimo: null };
  const msDia = 86400000;
  const emMs = (s: string) => new Date(s + 'T12:00:00').getTime();
  const conjunto = new Set(dias);

  let recorde = 0;
  let seq = 0;
  let anterior = 0;
  for (const d of dias) {
    const t = emMs(d);
    seq = anterior && Math.round((t - anterior) / msDia) === 1 ? seq + 1 : 1;
    anterior = t;
    if (seq > recorde) recorde = seq;
  }

  let atual = 0;
  const ultimoMs = emMs(dias[dias.length - 1]);
  if (Math.round((emMs(diaISO()) - ultimoMs) / msDia) <= 1) {
    let cursor = ultimoMs;
    for (let i = 0; i < 3650; i++) {
      if (!conjunto.has(diaISO(new Date(cursor)))) break;
      atual++;
      cursor -= msDia;
    }
  }
  return { atual, recorde, ultimo: dias[dias.length - 1] };
}

/** Dias sem treinar e se jÃ¡ passou do limite escolhido pelo aluno. */
function revisaoDe(p: Perfil) {
  const dias = Object.keys(p.atividade ?? {}).filter(d => (p.atividade![d] ?? 0) > 0).sort();
  const hoje = new Date(diaISO() + 'T12:00:00').getTime();
  const referencia = dias.length
    ? new Date(dias[dias.length - 1] + 'T12:00:00').getTime()
    : new Date(p.criadoEm).getTime();
  const diasSemTreinar = Math.max(0, Math.round((hoje - referencia) / 86400000));
  const limite = (p.prefs ?? PREFS_PADRAO).diasRevisao;
  return {
    diasSemTreinar,
    limite,
    precisaRevisao: diasSemTreinar >= limite && (p.historico ?? []).length > 0
  };
}

/** Progresso da meta do dia (em sessÃµes ou em minutos). */
function metaDoDia(p: Perfil) {
  const dia = diaISO();
  const sessoes = (p.atividade ?? {})[dia] ?? 0;
  const minutos = Math.round((p.atividadeMin ?? {})[dia] ?? 0);
  const alvo = (p.prefs ?? PREFS_PADRAO).metaDia;
  const feito = alvo.tipo === 'minutos' ? minutos : sessoes;
  const valor = Math.max(1, alvo.valor);
  return {
    tipo: alvo.tipo,
    alvo: alvo.valor,
    feito,
    pct: Math.min(100, Math.round((feito / valor) * 100)),
    cumprida: feito >= alvo.valor
  };
}

/** Marca que o aluno treinou hoje (conta para ofensiva e para a meta do dia). */
function registrarAtividade(p: Perfil, segundos: number) {
  const dia = diaISO();
  p.atividade ??= {};
  p.atividadeMin ??= {};
  p.atividade[dia] = (p.atividade[dia] ?? 0) + 1;
  const minutos = Math.max(0, segundos || 0) / 60;
  p.atividadeMin[dia] = Math.round(((p.atividadeMin[dia] ?? 0) + minutos) * 10) / 10;
}

/** Ãndice do ranking: velocidade pesada pela precisÃ£o ao quadrado. */
function indiceDe(p: Perfil) {
  const ultimas = (p.historico ?? []).slice(-20);
  if (!ultimas.length) return { indice: 0, wpm: 0, precisao: 0, base: 0 };
  const wpm = Math.round(ultimas.reduce((s, r) => s + r.wpm, 0) / ultimas.length);
  const precisao = Math.round(ultimas.reduce((s, r) => s + r.precisao, 0) / ultimas.length);
  return { indice: Math.round(wpm * Math.pow(precisao / 100, 2)), wpm, precisao, base: ultimas.length };
}

/** Tudo que a tela precisa para montar o painel do aluno. */
function painelDe(p: Perfil) {
  normalizarExtras(p);
  const segundos =
    p.historico.reduce((s, r) => s + (r.segundos || 0), 0) +
    p.testes!.reduce((s, t) => s + (t.segundos || 0), 0) +
    p.jogoHistorico!.reduce((s, j) => s + (j.segundos || 0), 0);

  return {
    ofensiva: calcularOfensiva(p),
    metaDia: metaDoDia(p),
    revisao: revisaoDe(p),
    indice: indiceDe(p),
    recordes: p.recordes,
    melhorCombo: p.melhorCombo ?? 0,
    tempoTotalMin: Math.round(segundos / 60),
    licoesFeitas: p.historico.length,
    perfeitosSeguidos: p.perfeitosSeguidos ?? 0,
    prefs: p.prefs,
    testes: p.testes!.slice(-12),
    jogo: p.jogoHistorico!.slice(-12),
    atividade: p.atividade,
    numeros: p.numeros,
    conquistas: CATALOGO_CONQUISTAS.map(c => {
      const ganha = (p.conquistas ?? []).find(x => x.id === c.id);
      return { id: c.id, nome: c.nome, desc: c.desc, icone: c.icone, em: ganha ? ganha.em : null };
    })
  };
}

/** Atualiza os recordes de liÃ§Ã£o e devolve quais foram quebrados. */
function atualizarRecordesLicao(p: Perfil, wpm: number, precisao: number, combo: number): string[] {
  const novos: string[] = [];
  const r = p.recordes!;
  const agora = new Date().toISOString();
  if (wpm > r.wpm) {
    r.wpm = wpm;
    r.wpmEm = agora;
    novos.push('wpm');
  }
  if (precisao > r.precisao) {
    r.precisao = precisao;
    r.precisaoEm = agora;
    novos.push('precisao');
  }
  if (combo > r.combo) {
    r.combo = combo;
    r.comboEm = agora;
    novos.push('combo');
  }
  if (combo > (p.melhorCombo ?? 0)) p.melhorCombo = combo;
  return novos;
}

/** Libera as conquistas que o aluno passou a cumprir agora. */
function verificarConquistas(p: Perfil): Conquista[] {
  const ganhas = new Set((p.conquistas ?? []).map(c => c.id));
  const novas: Conquista[] = [];
  const dar = (id: string) => {
    if (ganhas.has(id)) return;
    const c: Conquista = { id, em: new Date().toISOString() };
    p.conquistas!.push(c);
    ganhas.add(id);
    novas.push(c);
  };

  const totalTeclas = Object.values(p.teclas ?? {}).reduce((s, t) => s + (t.t || 0), 0);
  const ofensiva = calcularOfensiva(p);
  const r = p.recordes!;

  if ((p.historico ?? []).some(l => l.precisao === 100)) dar('primeiro-100');
  for (const marco of [20, 30, 40, 50, 60]) if (r.wpm >= marco) dar(`wpm-${marco}`);
  for (const marco of [3, 7, 30]) if (ofensiva.recorde >= marco) dar(`ofensiva-${marco}`);
  if (totalTeclas >= 1000) dar('mil-teclas');
  if (r.teste1min) dar('teste-1min');
  if (r.teste1min && r.teste1min.wpm >= 40) dar('teste-40');
  if (r.corrida30s) dar('corrida-30s');
  if (r.jogo) dar('jogo-estreia');
  if (r.jogo && r.jogo.onda >= 5) dar('jogo-onda-5');
  if (r.jogo && r.jogo.combo >= 20) dar('jogo-combo-20');
  if ((p.concluidaAte ?? 0) >= LIBERA_AVANCADO) dar('avancado-liberado');
  if ((p.concluidaAte ?? 0) >= 10) dar('dez-licoes');
  return novas;
}

const jaProcessado = (p: Perfil, id?: string) => !!id && (p.idsProcessados ?? []).includes(id);
function marcarProcessado(p: Perfil, id?: string) {
  if (!id) return;
  p.idsProcessados ??= [];
  p.idsProcessados.push(id);
  if (p.idsProcessados.length > IDS_PROCESSADOS_MAX) {
    p.idsProcessados.splice(0, p.idsProcessados.length - IDS_PROCESSADOS_MAX);
  }
}

/** Letras que o aluno jÃ¡ pode praticar (liÃ§Ãµes concluÃ­das + AvanÃ§ado). */
function letrasDePratica(p: Perfil): Set<string> {
  const base = new Set<string>(['a', 's', 'd', 'f', 'j', 'k', 'l']);
  letrasAcumuladas(Math.max(1, p.nivel)).forEach(c => base.add(c));
  if ((p.concluidaAte ?? 0) >= LIBERA_AVANCADO) avLetras(p.av.nivel).forEach(c => base.add(c));
  return base;
}

function palavrasDePratica(p: Perfil): string[] {
  const letras = letrasDePratica(p);
  const ok = PALAVRAS.filter(w => [...w].every(c => letras.has(c)));
  return ok.length >= 12 ? ok : PALAVRAS.filter(w => w.length <= 4);
}

/** Texto do teste cronometrado: palavras conhecidas, com peso nas teclas fracas. */
function textoDeTeste(p: Perfil, segundos: number): string {
  const pool = palavrasDePratica(p);
  const fracas = p.fracas ?? {};
  const itens = pool.map(w => [w, 1 + [...w].filter(c => fracas[c]).length * 4] as [string, number]);
  const alvo = segundos >= 60 ? 360 : 210;
  const partes: string[] = [];
  let total = 0;
  while (total < alvo && partes.length < 400) {
    const w = sortearPonderado(itens);
    if (!w) break;
    partes.push(w);
    total += w.length + 1;
  }
  return partes.join(' ');
}

/** Texto curto de aquecimento/revisÃ£o (30 segundos). */
function textoDeDrill(p: Perfil, origem: 'revisao' | 'aquecimento' | 'fracas') {
  const grupos: string[] = [];
  if (origem === 'aquecimento') {
    const pos = posDe(p);
    const daEtapa = [...letrasDaEtapa(pos.trilha, pos.nivel, pos.etapa)];
    const letras = daEtapa.length ? daEtapa : ['f', 'j'];
    for (let i = 0; i < 18; i++) {
      const tam = 3 + Math.floor(Math.random() * 3);
      grupos.push(Array.from({ length: tam }, () => sortear(letras)).join(''));
    }
    return { texto: grupos.join(' '), titulo: 'Aquecimento de 30 segundos', segundos: 30 };
  }

  const fracas = Object.keys(p.fracas ?? {}).filter(c => c.trim().length === 1);
  const base = new Set<string>(fracas);
  if (origem === 'revisao' || base.size < 2) letrasDePratica(p).forEach(c => base.add(c));
  const letras = [...base].filter(c => c.trim().length === 1);
  for (let i = 0; i < 20; i++) {
    const tam = 3 + Math.floor(Math.random() * 3);
    grupos.push(Array.from({ length: tam }, () => sortear(letras.length ? letras : ['f', 'j'])).join(''));
  }
  return {
    texto: grupos.join(' '),
    titulo: origem === 'revisao' ? 'RevisÃ£o de 30 segundos' : 'Treino das teclas fracas',
    segundos: 30
  };
}

/** Banco de palavras do jogo, com peso maior nas teclas fracas do perfil. */
function palavrasDoJogo(p: Perfil) {
  const letras = letrasDePratica(p);
  let pool = PALAVRAS.filter(w => w.length >= 3 && w.length <= 9 && [...w].every(c => letras.has(c)));
  if (pool.length < 20) pool = PALAVRAS.filter(w => w.length >= 3 && w.length <= 6);
  const fracas = p.fracas ?? {};
  const palavras = pool.slice(0, 600).map(w => ({
    p: w,
    peso: 1 + [...w].reduce((s, c) => s + (fracas[c] ? fracas[c].peso : 0), 0) * 2
  }));
  return { palavras, letras: [...letras].sort().join('') };
}

/** ExercÃ­cios fixos de nÃºmeros e sÃ­mbolos (prÃ¡tica avulsa, nÃ£o mexe na posiÃ§Ã£o). */
const NUMEROS_EXERCICIOS: { id: string; titulo: string; dica: string; texto: string }[] = [
  {
    id: 'numeros',
    titulo: 'Fileira dos nÃºmeros',
    dica: 'Fileira de cima, sem olhar para o teclado. Polegar fica no espaÃ§o.',
    texto: '11 22 33 44 55 66 77 88 99 00 12 34 56 78 90 10 20 30 40 50 60 70 80 91 82 73 64 55 46 37 28 19 01 02 03 04 05 06 07 08 09 99 88 77 66 55 44 33 22 11'
  },
  {
    id: 'simbolos',
    titulo: 'SÃ­mbolos com Shift',
    dica: 'Shift com o dedo oposto Ã  tecla. Ex.: @ usa AltGr+2 no teclado ABNT2.',
    texto: '! @ # $ % & * ( ) _ + = - / ? ; : , . 10% de 200 100% (50) [30] {20} a+b=c 3*4+5 10/2 = 5 @#$ !!! ??? (( )) [[ ]] {{ }}'
  },
  {
    id: 'acentos',
    titulo: 'AcentuaÃ§Ã£o do portuguÃªs',
    dica: 'Acento agudo, til e cedilha sÃ£o teclas mortas: acento primeiro, letra depois.',
    texto: 'nÃ£o sim aÃ§Ã£o coraÃ§Ã£o canÃ§Ã£o pÃ£o mÃ£e irmÃ£ avÃ´ avÃ³ cafÃ© vocÃª atÃ© pÃ© mÃªs paÃ­s inÃ­cio Ã³rgÃ£o trÃªs jÃ¡ estÃ¡ apÃ³s atrÃ¡s tambÃ©m serÃ¡ possÃ­vel Ã¡gua informaÃ§Ã£o'
  },
  {
    id: 'email',
    titulo: 'E-mail e endereÃ§o',
    dica: 'O arroba e a barra aparecem em quase todo cadastro.',
    texto: 'maria@escola.com.br joao.silva@empresa.com www.jev.com.br site/curso?aluno=1 http://localhost:3000 aluno_01@teste.com.br contato@loja.com.br https://exemplo.com/pagina?id=42'
  },
  {
    id: 'dinheiro',
    titulo: 'NÃºmeros, dinheiro e horÃ¡rio',
    dica: 'VÃ­rgula no decimal, ponto no milhar e dois-pontos na hora.',
    texto: 'R$ 1.250,00 R$ 39,90 R$ 5,50 07:30 18:45 23:59 1/1/2026 31/12/2025 10% de 250 = 25 3,5 kg 1.000 pessoas 2.500,00 99,99 12:00 00:00'
  },
  {
    id: 'codigo',
    titulo: 'SÃ­mbolos de cÃ³digo',
    dica: 'Chaves, colchetes, ponto e vÃ­rgula: os sÃ­mbolos de quem escreve cÃ³digo.',
    texto: 'function somar(a, b) { return a + b; } if (x >= 10 && y != 0) { alert("ok"); } lista[0] = { id: 1, ativo: true }; total = a * (b + c) / 2;'
  }
];

/** CÃ³pia de seguranÃ§a completa do estado (no banco ou em backups/ local). */
let ultimoBackup = 0;
async function backupRotativo(forcar = false): Promise<string | null> {
  const agora = Date.now();
  if (!forcar && agora - ultimoBackup < BACKUP_INTERVALO_MS) return null;
  ultimoBackup = agora;
  return store.criarBackup({
    geradoEm: new Date().toISOString(),
    versao: 2,
    config,
    licoes,
    avLicoes,
    perfis: [...perfis, ...lixeira] // a lixeira tambÃ©m entra no backup
  });
}

// ---------------------------------------------------------------------------
// Rotas do painel
// ---------------------------------------------------------------------------
app.get('/api/painel', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  res.json({ painel: painelDe(p) });
});

const SchemaPrefs = z.object({
  diasRevisao: z.number().int().min(1).max(60).optional(),
  metaDia: z.object({ tipo: z.enum(['sessoes', 'minutos']), valor: z.number().int().min(1).max(600) }).optional(),
  jogoTamanho: z.enum(['normal', 'grande']).optional(),
  reduzirMovimento: z.boolean().optional()
});

app.put('/api/perfis/:id/prefs', async (req, res) => {
  const p = perfis.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const r = SchemaPrefs.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'PreferÃªncias invÃ¡lidas.' });
  const prefs = p.prefs!;
  if (r.data.diasRevisao != null) prefs.diasRevisao = r.data.diasRevisao;
  if (r.data.metaDia) prefs.metaDia = { ...r.data.metaDia } as MetaDia;
  if (r.data.jogoTamanho) prefs.jogoTamanho = r.data.jogoTamanho;
  if (r.data.reduzirMovimento != null) prefs.reduzirMovimento = r.data.reduzirMovimento;
  await salvar();
  res.json({ prefs, painel: painelDe(p) });
});

app.get('/api/ranking', (_req, res) => {
  const lista = perfis.map(p => {
    ajustarPerfil(p);
    const idx = indiceDe(p);
    const ofensiva = calcularOfensiva(p);
    return {
      id: p.id,
      nome: p.nome,
      cor: p.cor,
      indice: idx.indice,
      wpm: idx.wpm,
      precisao: idx.precisao,
      base: idx.base,
      melhorWpm: p.recordes!.wpm,
      melhorPrecisao: p.recordes!.precisao,
      melhorCombo: p.melhorCombo ?? 0,
      licoes: p.historico.length,
      ofensiva: ofensiva.atual,
      ofensivaRecorde: ofensiva.recorde,
      melhorTeste: p.recordes!.teste1min ? p.recordes!.teste1min!.wpm : 0,
      melhorCorrida: p.recordes!.corrida30s ? p.recordes!.corrida30s!.pontos : 0,
      melhorJogo: p.recordes!.jogo ? p.recordes!.jogo!.pontos : 0,
      minutos: Math.round(
        (p.historico.reduce((s, r) => s + (r.segundos || 0), 0) +
          p.testes!.reduce((s, t) => s + (t.segundos || 0), 0) +
          p.jogoHistorico!.reduce((s, j) => s + (j.segundos || 0), 0)) / 60
      ),
      calibrando: idx.base < MIN_LICOES_RANKING,
      ultima: p.historico.length ? p.historico[p.historico.length - 1].data : p.criadoEm
    };
  });

  lista.sort((a, b) => {
    if (a.calibrando !== b.calibrando) return a.calibrando ? 1 : -1;
    return b.indice - a.indice || b.melhorWpm - a.melhorWpm;
  });

  res.json({
    formula: 'Ãndice = palavras por minuto mÃ©dias Ã— (precisÃ£o mÃ©dia Ã· 100)Â² nas Ãºltimas 20 liÃ§Ãµes',
    minimo: MIN_LICOES_RANKING,
    perfis: lista.map((x, i) => ({ ...x, posicao: i + 1 }))
  });
});

app.get('/api/perfis/:id/exportar', (req, res) => {
  const p = perfis.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  res.json({ formato: 'curso-digitacao-perfil', versao: 2, exportadoEm: new Date().toISOString(), perfil: p });
});

app.post('/api/perfis/importar', async (req, res) => {
  const corpo = objeto(req.body);
  if (!corpo) return res.status(400).json({ erro: 'Arquivo de backup invÃ¡lido.' });
  const dados = objeto(corpo.perfil) ?? objeto(corpo.dados) ?? objeto(corpo.backup) ?? corpo;
  if (!dados || typeof dados.nome !== 'string' || !dados.nome.trim()) {
    return res.status(400).json({ erro: 'O backup nÃ£o tem o nome do perfil.' });
  }

  const nomeBase = dados.nome.trim().slice(0, 20);
  let nome = nomeBase;
  let i = 2;
  while (perfis.some(x => x.nome.toLowerCase() === nome.toLowerCase())) {
    const sufixo = ` (${i++})`;
    nome = nomeBase.slice(0, Math.max(1, 20 - sufixo.length)) + sufixo;
  }

  const cor = (CORES_PERFIL as readonly string[]).includes(String(dados.cor)) ? String(dados.cor) : sortear(CORES_PERFIL);
  const p = novoPerfil(nome, cor);

  p.nivel = inteiro(dados.nivel, 1, 1, MAX_LICOES);
  p.etapa = inteiro(dados.etapa, 1, 1, 50);
  p.concluidaAte = inteiro(dados.concluidaAte, 0, 0, MAX_LICOES);
  p.tentativasEtapa = inteiro(dados.tentativasEtapa, 0, 0, 100000);
  p.perfeitosSeguidos = inteiro(dados.perfeitosSeguidos, 0, 0, 100000);
  p.melhorCombo = inteiro(dados.melhorCombo, 0, 0, 100000);
  if (dados.trilha === 'a' || dados.trilha === 'l') p.trilha = dados.trilha;
  if (typeof dados.criadoEm === 'string') p.criadoEm = dados.criadoEm;

  const av = objeto(dados.av);
  if (av) {
    p.av = {
      nivel: inteiro(av.nivel, 1, 1, MAX_LICOES),
      etapa: inteiro(av.etapa, 1, 1, 50),
      concluidaAte: inteiro(av.concluidaAte, 0, 0, MAX_LICOES)
    };
  }

  const fracas = objeto(dados.fracas);
  if (fracas) {
    p.fracas = {};
    for (const [k, v] of Object.entries(fracas)) {
      const o = objeto(v);
      if (!o || k.length !== 1) continue;
      p.fracas[k] = { semErro: inteiro(o.semErro, 0, 0, 999), peso: inteiro(o.peso, 0, 0, 999) };
    }
  }
  const pares = objeto(dados.fracasPares);
  if (pares) {
    p.fracasPares = {};
    for (const [k, v] of Object.entries(pares)) {
      const o = objeto(v);
      if (!o || !k.includes('>')) continue;
      p.fracasPares[k] = { semErro: inteiro(o.semErro, 0, 0, 999), peso: inteiro(o.peso, 0, 0, 999) };
    }
  }

  const teclas = objeto(dados.teclas);
  if (teclas) {
    p.teclas = {};
    for (const [k, v] of Object.entries(teclas)) {
      const o = objeto(v);
      if (!o) continue;
      p.teclas[k] = { t: inteiro(o.t, 0, 0, 1000000), e: inteiro(o.e, 0, 0, 1000000) };
      if (o.m != null) p.teclas[k].m = inteiro(o.m, 0, 0, 1000000000);
      if (o.c != null) p.teclas[k].c = inteiro(o.c, 0, 0, 1000000);
    }
  }

  if (Array.isArray(dados.historico)) {
    p.historico = dados.historico
      .filter(r => r && typeof r === 'object')
      .slice(-HISTORICO_MAX)
      .map(r => ({
        data: typeof r.data === 'string' ? r.data : new Date().toISOString(),
        nivel: inteiro(r.nivel, 1, 1, MAX_LICOES),
        etapa: inteiro(r.etapa, 1, 1, 50),
        trilha: r.trilha === 'a' ? ('a' as TrilhaId) : ('l' as TrilhaId),
        wpm: inteiro(r.wpm, 0, 0, 400),
        precisao: inteiro(r.precisao, 0, 0, 100),
        segundos: inteiro(r.segundos, 0, 0, 86400),
        decididoPor: r.decididoPor === 'jev' ? ('jev' as const) : ('regra' as const),
        confianca: typeof r.confianca === 'number' ? r.confianca : null,
        fluencia: typeof r.fluencia === 'number' ? r.fluencia : null,
        teclaFraca: typeof r.teclaFraca === 'string' ? r.teclaFraca : null
      })) as RegistroLicao[];
  }

  if (Array.isArray(dados.testes)) {
    p.testes = dados.testes
      .filter(x => x && typeof x === 'object')
      .slice(-HISTORICO_TESTES_MAX)
      .map(x => ({
        data: typeof x.data === 'string' ? x.data : new Date().toISOString(),
        tipo: x.tipo === '30s' ? ('30s' as const) : ('1min' as const),
        wpm: inteiro(x.wpm, 0, 0, 400),
        precisao: inteiro(x.precisao, 0, 0, 100),
        pontos: inteiro(x.pontos, 0, 0, 1000000),
        segundos: inteiro(x.segundos, 0, 0, 3600)
      })) as ResultadoTeste[];
  }

  if (Array.isArray(dados.jogoHistorico)) {
    p.jogoHistorico = dados.jogoHistorico
      .filter(x => x && typeof x === 'object')
      .slice(-HISTORICO_JOGO_MAX)
      .map(x => ({
        data: typeof x.data === 'string' ? x.data : new Date().toISOString(),
        modalidade: x.modalidade === 'precisao' ? ('precisao' as const) : x.modalidade === 'zen' ? ('zen' as const) : ('classico' as const),
        pontos: inteiro(x.pontos, 0, 0, 1000000),
        onda: inteiro(x.onda, 1, 1, 9999),
        combo: inteiro(x.combo, 0, 0, 100000),
        precisao: inteiro(x.precisao, 0, 0, 100),
        palavras: inteiro(x.palavras, 0, 0, 100000),
        segundos: inteiro(x.segundos, 0, 0, 7200)
      })) as ResultadoJogo[];
  }

  const atividade = objeto(dados.atividade);
  if (atividade) {
    p.atividade = {};
    for (const [k, v] of Object.entries(atividade)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const n = inteiro(v, 0, 0, 5000);
      if (n > 0) p.atividade[k] = n;
    }
  }
  const atividadeMin = objeto(dados.atividadeMin);
  if (atividadeMin) {
    p.atividadeMin = {};
    for (const [k, v] of Object.entries(atividadeMin)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const n = Math.round(num(v, 0, 0, 100000) * 10) / 10;
      if (n > 0) p.atividadeMin[k] = n;
    }
  }

  if (Array.isArray(dados.conquistas)) {
    p.conquistas = dados.conquistas
      .filter(c => c && typeof c.id === 'string' && CATALOGO_CONQUISTAS.some(x => x.id === c.id))
      .map(c => ({ id: String(c.id), em: typeof c.em === 'string' ? c.em : new Date().toISOString() })) as Conquista[];
  }

  const numeros = objeto(dados.numeros);
  if (numeros) {
    p.numeros = {};
    for (const [k, v] of Object.entries(numeros)) {
      const o = objeto(v);
      if (!o || !NUMEROS_EXERCICIOS.some(e => e.id === k)) continue;
      p.numeros[k] = {
        wpm: inteiro(o.wpm, 0, 0, 400),
        precisao: inteiro(o.precisao, 0, 0, 100),
        em: typeof o.em === 'string' ? o.em : new Date().toISOString()
      };
    }
  }

  const prefs = objeto(dados.prefs);
  if (prefs) {
    const meta = objeto(prefs.metaDia) ?? {};
    p.prefs = {
      diasRevisao: inteiro(prefs.diasRevisao, PREFS_PADRAO.diasRevisao, 1, 60),
      metaDia: {
        tipo: meta.tipo === 'minutos' ? 'minutos' : 'sessoes',
        valor: inteiro(meta.valor, PREFS_PADRAO.metaDia.valor, 1, 600)
      },
      jogoTamanho: prefs.jogoTamanho === 'grande' ? 'grande' : 'normal',
      reduzirMovimento: prefs.reduzirMovimento === true
    };
  }

  const recordes = objeto(dados.recordes);
  if (recordes) {
    const teste = (v: unknown): RecordeTeste | null => {
      const o = objeto(v);
      if (!o) return null;
      return {
        wpm: inteiro(o.wpm, 0, 0, 400),
        precisao: inteiro(o.precisao, 0, 0, 100),
        pontos: inteiro(o.pontos, 0, 0, 1000000),
        em: typeof o.em === 'string' ? o.em : new Date().toISOString()
      };
    };
    const jr = objeto(recordes.jogo);
    p.recordes = {
      wpm: inteiro(recordes.wpm, 0, 0, 400),
      wpmEm: typeof recordes.wpmEm === 'string' ? recordes.wpmEm : null,
      precisao: inteiro(recordes.precisao, 0, 0, 100),
      precisaoEm: typeof recordes.precisaoEm === 'string' ? recordes.precisaoEm : null,
      combo: inteiro(recordes.combo, 0, 0, 100000),
      comboEm: typeof recordes.comboEm === 'string' ? recordes.comboEm : null,
      teste1min: teste(recordes.teste1min),
      corrida30s: teste(recordes.corrida30s),
      jogo: jr
        ? {
            pontos: inteiro(jr.pontos, 0, 0, 1000000),
            onda: inteiro(jr.onda, 1, 1, 9999),
            combo: inteiro(jr.combo, 0, 0, 100000),
            em: typeof jr.em === 'string' ? jr.em : new Date().toISOString()
          }
        : null
    };
  }

  ajustarPerfil(p);
  perfis.push(p);
  await salvar();
  res.status(201).json({ perfil: resumo(p), painel: painelDe(p) });
});

app.get('/api/backup', (_req, res) => {
  res.json({
    formato: 'curso-digitacao-completo',
    versao: 2,
    exportadoEm: new Date().toISOString(),
    config,
    licoes,
    avLicoes,
    perfis
  });
});

app.get('/api/backups', async (_req, res) => {
  try {
    res.json(await store.listarBackups());
  } catch (erro) {
    res.status(500).json({ erro: 'NÃ£o consegui listar os backups.', detalhe: String(erro) });
  }
});

app.post('/api/backups', async (_req, res) => {
  const caminho = await backupRotativo(true);
  res.json({ sucesso: !!caminho, arquivo: caminho });
});

// ---------------------------------------------------------------------------
// PrÃ¡tica avulsa: aquecimento, revisÃ£o, teclas fracas e nÃºmeros/sÃ­mbolos.
// NÃ£o mexe na posiÃ§Ã£o do aluno (nem em etapa, nem em liÃ§Ã£o).
// ---------------------------------------------------------------------------
app.get('/api/pratica/texto', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const origem =
    req.query.origem === 'aquecimento' ? 'aquecimento' : req.query.origem === 'fracas' ? 'fracas' : 'revisao';
  res.json(textoDeDrill(p, origem));
});

app.get('/api/numeros', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (p) ajustarPerfil(p);
  res.json({
    exercicios: NUMEROS_EXERCICIOS.map(e => ({
      id: e.id,
      titulo: e.titulo,
      dica: e.dica,
      caracteres: e.texto.length,
      melhor: p && p.numeros ? p.numeros[e.id] ?? null : null
    }))
  });
});

app.get('/api/numeros/:id', (req, res) => {
  const e = NUMEROS_EXERCICIOS.find(x => x.id === req.params.id);
  if (!e) return res.status(404).json({ erro: 'ExercÃ­cio nÃ£o encontrado.' });
  res.json({ id: e.id, titulo: e.titulo, dica: e.dica, texto: e.texto, segundos: 0 });
});

const SchemaTreinoLivre = z.object({
  perfilId: z.string(),
  origem: z.enum(['revisao', 'aquecimento', 'fracas', 'numeros', 'livre']),
  exercicioId: z.string().max(40).optional(),
  segundos: z.number().min(0).max(3600),
  comboMax: z.number().int().min(0).max(100000).optional(),
  id: z.string().max(64).optional(),
  eventosTeclas: z.array(SchemaEvento).min(1)
});

app.post('/api/treino-livre', async (req, res) => {
  const r = SchemaTreinoLivre.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Dados enviados invÃ¡lidos.' });
  const dados = r.data;
  const p = perfis.find(x => x.id === dados.perfilId);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);

  const acertos = dados.eventosTeclas.filter(e => e.correta).length;
  const total = dados.eventosTeclas.length;
  const precisao = total ? Math.round((acertos / total) * 100) : 0;
  const minutos = Math.max(1, dados.segundos) / 60;
  const wpm = Math.round(acertos / 5 / minutos);

  if (jaProcessado(p, dados.id)) {
    return res.json({
      sucesso: true,
      duplicado: true,
      wpm,
      precisao,
      pontos: acertos,
      mensagem: 'Este treino jÃ¡ tinha sido registrado.',
      errosPorTecla: [],
      painel: painelDe(p),
      conquistasNovas: []
    });
  }

  const stats = analisarTeclas(dados.eventosTeclas);
  atualizarFracas(p, stats, contarPares(dados.eventosTeclas));
  for (const st of stats) {
    const acc = p.teclas[st.tecla] ?? { t: 0, e: 0, m: 0, c: 0 };
    acc.t += st.tentativas;
    acc.e += st.erros;
    if (st.tempoMedioMs > 0 && st.tentativas > 1) {
      acc.m = (acc.m ?? 0) + st.tempoMedioMs * (st.tentativas - 1);
      acc.c = (acc.c ?? 0) + (st.tentativas - 1);
    }
    p.teclas[st.tecla] = acc;
  }

  registrarAtividade(p, dados.segundos);
  if ((dados.comboMax ?? 0) > (p.melhorCombo ?? 0)) p.melhorCombo = dados.comboMax;

  const exercicio = dados.origem === 'numeros' ? NUMEROS_EXERCICIOS.find(e => e.id === dados.exercicioId) : undefined;
  if (exercicio && dados.exercicioId) {
    p.numeros ??= {};
    const anterior = p.numeros[dados.exercicioId];
    if (!anterior || wpm > anterior.wpm || precisao > anterior.precisao) {
      p.numeros[dados.exercicioId] = { wpm, precisao, em: new Date().toISOString() };
    }
  }

  const conquistasNovas = verificarConquistas(p);
  marcarProcessado(p, dados.id);
  await salvar();

  res.json({
    sucesso: true,
    wpm,
    precisao,
    pontos: acertos,
    segundos: dados.segundos,
    mensagem:
      dados.origem === 'numeros'
        ? `ExercÃ­cio de ${exercicio ? exercicio.titulo.toLowerCase() : 'nÃºmeros'} concluÃ­do.`
        : dados.origem === 'aquecimento'
          ? 'Aquecimento concluÃ­do. Agora o ritmo jÃ¡ estÃ¡ melhor.'
          : dados.origem === 'livre'
            ? 'Texto livre concluÃ­do.'
            : 'RevisÃ£o concluÃ­da. As teclas fracas agradecem.',
    errosPorTecla: stats.filter(s => s.erros > 0).slice(0, 5),
    conquistasNovas,
    painel: painelDe(p)
  });
});

// ---------------------------------------------------------------------------
// Testes cronometrados (1 minuto e corrida de 30 segundos)
// ---------------------------------------------------------------------------
app.get('/api/testes/texto', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const segundos = req.query.tipo === '30s' ? 30 : 60;
  res.json({
    tipo: segundos === 60 ? '1min' : '30s',
    segundos,
    titulo: segundos === 60 ? 'Teste de 1 minuto' : 'Corrida de 30 segundos',
    texto: textoDeTeste(p, segundos),
    recorde: p.recordes ? p.recordes[segundos === 60 ? 'teste1min' : 'corrida30s'] : null
  });
});

const SchemaTeste = z.object({
  perfilId: z.string(),
  tipo: z.enum(['1min', '30s']),
  segundos: z.number().min(1).max(600),
  comboMax: z.number().int().min(0).max(100000).optional(),
  id: z.string().max(64).optional(),
  eventosTeclas: z.array(SchemaEvento).min(1)
});

app.post('/api/testes', async (req, res) => {
  const r = SchemaTeste.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Dados enviados invÃ¡lidos.' });
  const dados = r.data;
  const p = perfis.find(x => x.id === dados.perfilId);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);

  const acertos = dados.eventosTeclas.filter(e => e.correta).length;
  const total = dados.eventosTeclas.length;
  const precisao = total ? Math.round((acertos / total) * 100) : 0;
  const wpm = Math.round(acertos / 5 / (dados.segundos / 60));
  const pontos = acertos;

  if (jaProcessado(p, dados.id)) {
    return res.json({
      sucesso: true,
      duplicado: true,
      tipo: dados.tipo,
      wpm,
      precisao,
      pontos,
      recordeAnterior: null,
      novoRecorde: false,
      painel: painelDe(p),
      conquistasNovas: []
    });
  }

  const stats = analisarTeclas(dados.eventosTeclas);
  atualizarFracas(p, stats, contarPares(dados.eventosTeclas));
  for (const st of stats) {
    const acc = p.teclas[st.tecla] ?? { t: 0, e: 0, m: 0, c: 0 };
    acc.t += st.tentativas;
    acc.e += st.erros;
    p.teclas[st.tecla] = acc;
  }

  const chave = dados.tipo === '1min' ? 'teste1min' : 'corrida30s';
  const anterior = p.recordes ? p.recordes[chave] : null;
  const marca = chave === 'teste1min' ? wpm : pontos;
  const anteriorMarca = anterior ? (chave === 'teste1min' ? anterior.wpm : anterior.pontos) : 0;

  p.testes ??= [];
  p.testes.push({
    data: new Date().toISOString(),
    tipo: dados.tipo,
    wpm,
    precisao,
    pontos,
    segundos: dados.segundos
  });
  if (p.testes.length > HISTORICO_TESTES_MAX) p.testes.splice(0, p.testes.length - HISTORICO_TESTES_MAX);

  let novoRecorde = false;
  if (marca > anteriorMarca) {
    novoRecorde = true;
    p.recordes![chave] = { wpm, precisao, pontos, em: new Date().toISOString() };
  }

  registrarAtividade(p, dados.segundos);
  if ((dados.comboMax ?? 0) > (p.melhorCombo ?? 0)) p.melhorCombo = dados.comboMax;
  const conquistasNovas = verificarConquistas(p);
  marcarProcessado(p, dados.id);
  await salvar();

  res.json({
    sucesso: true,
    tipo: dados.tipo,
    wpm,
    precisao,
    pontos,
    segundos: dados.segundos,
    recordeAnterior: anteriorMarca,
    novoRecorde,
    conquistasNovas,
    painel: painelDe(p)
  });
});

// ---------------------------------------------------------------------------
// Jogo das palavras (nÃ£o mexe na posiÃ§Ã£o nem nas metas das liÃ§Ãµes)
// ---------------------------------------------------------------------------
app.get('/api/jogo/palavras', (req, res) => {
  const p = perfis.find(x => x.id === req.query.perfil);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);
  const { palavras, letras } = palavrasDoJogo(p);
  res.json({ palavras, letras, recorde: p.recordes!.jogo, modalidades: ['classico', 'precisao', 'zen'] });
});

const SchemaJogo = z.object({
  perfilId: z.string(),
  modalidade: z.enum(['classico', 'precisao', 'zen']),
  pontos: z.number().int().min(0).max(1000000),
  onda: z.number().int().min(1).max(9999),
  combo: z.number().int().min(0).max(100000),
  precisao: z.number().min(0).max(100),
  palavras: z.number().int().min(0).max(100000),
  segundos: z.number().min(0).max(7200),
  id: z.string().max(64).optional()
});

app.post('/api/jogo/resultado', async (req, res) => {
  const r = SchemaJogo.safeParse(req.body);
  if (!r.success) return res.status(400).json({ erro: 'Dados do jogo invÃ¡lidos.' });
  const dados = r.data;
  const p = perfis.find(x => x.id === dados.perfilId);
  if (!p) return res.status(404).json({ erro: 'Perfil nÃ£o encontrado.' });
  ajustarPerfil(p);

  if (jaProcessado(p, dados.id)) {
    return res.json({ sucesso: true, duplicado: true, novoRecorde: false, painel: painelDe(p), conquistasNovas: [] });
  }

  p.jogoHistorico ??= [];
  p.jogoHistorico.push({
    data: new Date().toISOString(),
    modalidade: dados.modalidade,
    pontos: dados.pontos,
    onda: dados.onda,
    combo: dados.combo,
    precisao: Math.round(dados.precisao),
    palavras: dados.palavras,
    segundos: dados.segundos
  });
  if (p.jogoHistorico.length > HISTORICO_JOGO_MAX) {
    p.jogoHistorico.splice(0, p.jogoHistorico.length - HISTORICO_JOGO_MAX);
  }

  let novoRecorde = false;
  // zen Ã© treino livre: conta atividade, mas nÃ£o entra nos recordes
  if (dados.modalidade !== 'zen') {
    const anterior = p.recordes!.jogo;
    if (!anterior || dados.pontos > anterior.pontos) {
      novoRecorde = true;
      p.recordes!.jogo = {
        pontos: dados.pontos,
        onda: anterior ? Math.max(anterior.onda, dados.onda) : dados.onda,
        combo: anterior ? Math.max(anterior.combo, dados.combo) : dados.combo,
        em: new Date().toISOString()
      };
    } else {
      p.recordes!.jogo = {
        pontos: anterior.pontos,
        onda: Math.max(anterior.onda, dados.onda),
        combo: Math.max(anterior.combo, dados.combo),
        em: anterior.em
      };
    }
  }
  if (dados.combo > (p.melhorCombo ?? 0)) p.melhorCombo = dados.combo;

  registrarAtividade(p, dados.segundos);
  const conquistasNovas = verificarConquistas(p);
  marcarProcessado(p, dados.id);
  await salvar();

  res.json({ sucesso: true, novoRecorde, conquistasNovas, painel: painelDe(p) });
});

// ---------------------------------------------------------------------------
// InicializaÃ§Ã£o (usada tanto pelo servidor local quanto pela funÃ§Ã£o da Vercel)
// ---------------------------------------------------------------------------
const TTL_FRESCOR_MS = 15000;
let ultimaCarga = 0;
let iniciado: Promise<void> | null = null;

/** Explica no terminal por que o banco nÃ£o foi usado (sÃ³ em desenvolvimento). */
async function avisarSemBanco(): Promise<void> {
  const d = await store.diagnosticoEnv();
  const linhas = ['âš ï¸  Nenhum banco configurado: os dados ficam em perfis.json / licoes.json (sÃ³ neste computador).'];
  if (!d.arquivoEnvExiste) {
    linhas.push(`NÃ£o encontrei o arquivo .env. Crie um em: ${d.caminhoEnv}`);
    linhas.push('AtenÃ§Ã£o: o app lÃª ".env" â€” o ".env.example" Ã© sÃ³ o modelo.');
  } else {
    linhas.push(`O arquivo .env existe (${d.caminhoEnv}), mas nenhuma variÃ¡vel de banco estÃ¡ preenchida.`);
  }
  linhas.push('OpÃ§Ã£o 1 (sem senha): SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY');
  linhas.push('OpÃ§Ã£o 2: DATABASE_URL + DB_SENHA');
  linhas.push('Salve o .env e rode de novo: npm run dev');
  console.warn(linhas.join('\n'));
}

export function iniciar(): Promise<void> {
  if (iniciado) return iniciado;
  iniciado = (async () => {
    await carregarLicoes();
    await carregarPerfis();
    ultimaCarga = Date.now();
    if (!process.env.VERCEL) {
      await backupRotativo(true).catch(() => {});
      if (!store.naNuvem()) await avisarSemBanco();
    }
  })().catch(erro => {
    iniciado = null; // permite tentar de novo na prÃ³xima requisiÃ§Ã£o
    throw erro;
  });
  return iniciado;
}

/**
 * Cada instÃ¢ncia (lambda) tem a sua memÃ³ria. Com banco configurado, relemos os
 * dados de tempos em tempos para o ranking nÃ£o ficar velho entre instÃ¢ncias.
 */
async function garantirFresco(): Promise<void> {
  if (!store.naNuvem()) return;
  if (ultimaCarga && Date.now() - ultimaCarga < TTL_FRESCOR_MS) return;
  await fila; // espera as gravaÃ§Ãµes pendentes antes de reler
  await carregarPerfis();
  await carregarLicoes(false); // relÃª sem regravar
  ultimaCarga = Date.now();
}

// ---------------------------------------------------------------------------
// Erro nÃ£o tratado: devolve JSON (mais fÃ¡cil de ler no log da Vercel)
// ---------------------------------------------------------------------------
app.use((erro: any, _req: any, res: any, _next: any) => {
  console.error('Erro na API:', erro);
  if (res.headersSent) return;
  res.status(500).json({
    erro: 'Erro interno no servidor.',
    detalhe: erro instanceof Error ? erro.message : String(erro)
  });
});

export { app };

// Fora da Vercel (npm run dev) subimos o servidor normalmente.
if (!process.env.VERCEL) {
  iniciar()
    .then(() =>
      app.listen(PORT, () => {
        console.log(`Servidor pedagÃ³gico rodando na porta ${PORT} (${licoes.length} liÃ§Ãµes)`);
        console.log(`Dados em: ${store.descrever()}`);
        console.log(JEV_API_KEY ? 'Jev: chave encontrada.' : 'Jev: JEV_API_KEY ausente, rodando sÃ³ com a regra fixa.');
        console.log(CODIGO_ACESSO ? 'Acesso: protegido por cÃ³digo.' : 'Acesso: aberto (defina CODIGO_ACESSO para proteger).');
        console.log('Extras: painel do dia, ofensiva, testes cronometrados, jogo das palavras, ranking e backups.');
      })
    )
    .catch(erro => {
      console.error('Falha ao iniciar o servidor:', erro);
      process.exitCode = 1;
    });
}
