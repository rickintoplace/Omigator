/** Vercel Function for the free tier; all logic is in server/freeTier.ts. */

import { configFromEnv, handleFreeTier } from '../server/freeTier.js';

const config = configFromEnv(process.env);

async function handle(req: Request): Promise<Response> {
  const cfg = await config;
  if (!cfg) {
    return new Response(JSON.stringify({ enabled: false }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
  return handleFreeTier(req, cfg);
}

export const GET = handle;
export const POST = handle;
