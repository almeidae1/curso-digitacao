import { app, iniciar } from '../server';

export default async function handler(req: any, res: any) {
  await iniciar();
  return (app as any)(req, res);
}
