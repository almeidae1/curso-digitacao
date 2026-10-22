// ---------------------------------------------------------------------------
// Entrada da API na Vercel.
//
// O arquivo api/[...rota].ts é uma "catch-all": TODA requisição /api/... chega
// aqui e é entregue ao Express, que já tem as rotas definidas em server.ts.
// Sem rewrite, sem mudança de caminho — o req.url chega inteiro.
// ---------------------------------------------------------------------------
import { app, iniciar } from '../server';

export default async function handler(req: any, res: any) {
  // carrega perfis/lições do Supabase uma vez por instância (fica em cache)
  await iniciar();
  return (app as any)(req, res);
}
