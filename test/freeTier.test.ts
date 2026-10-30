import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';
import { describe, expect, it } from 'vitest';
import { type FreeTierConfig, handleFreeTier, LIMITS, memoryStore } from '../server/freeTier';

const ORIGIN = 'https://omigator.rickinto.place';
const now = Date.parse('2026-10-30T12:00:00Z');

function setup(): FreeTierConfig {
  return { openrouterKey: 'sk-test', secret: 'x'.repeat(40), store: memoryStore(), origins: [ORIGIN], now: () => now };
}

const req = (action: string, init: { method?: string; body?: unknown; token?: string; ip?: string; origin?: string } = {}) =>
  new Request(`https://omigator.rickinto.place/api/free?action=${action}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-real-ip': init.ip ?? '203.0.113.7',
      origin: init.origin ?? ORIGIN,
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const LAPTOP = 'a'.repeat(64);
const PHONE = 'b'.repeat(64);

async function session(cfg: FreeTierConfig, ip?: string, device = LAPTOP) {
  const challenge = await (await handleFreeTier(req('challenge', { ip }), cfg)).json();
  const solution = await solveChallenge({ challenge, deriveKey });
  const res = await handleFreeTier(req('session', { body: { challenge, solution, device }, ip }), cfg);
  return { res, challenge, solution, body: await res.json() };
}

const visitorOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).v as string;

const criteria = [{ id: 'hypoxia', kind: 'require', text: 'Cells were cultured under hypoxia.' }];

describe('free tier', () => {
  it('reports its limits and refuses other origins', async () => {
    const cfg = setup();
    const status = await (await handleFreeTier(req('status'), cfg)).json();
    expect(status).toEqual({ enabled: true, limits: LIMITS });
    expect((await handleFreeTier(req('status', { origin: 'https://evil.example' }), cfg)).status).toBe(403);
  });

  it('gives a session only for a solved challenge, and only to the same visitor', async () => {
    const cfg = setup();
    const { res, challenge, solution, body } = await session(cfg);
    expect(res.status).toBe(200);
    expect(body.token).toMatch(/\./);
    // Another network cannot use this solution, and a session needs the device signature.
    expect((await handleFreeTier(req('session', { body: { challenge, solution, device: LAPTOP }, ip: '198.51.100.1' }), cfg)).status).toBe(403);
    expect((await handleFreeTier(req('session', { body: { challenge, solution } }), cfg)).status).toBe(400);
    expect((await handleFreeTier(req('session', { body: { challenge, solution, device: 'not-a-hash' } }), cfg)).status).toBe(400);
    // A wrong solution fails.
    const other = await (await handleFreeTier(req('challenge'), cfg)).json();
    expect((await handleFreeTier(req('session', { body: { challenge: other, solution: { ...solution, counter: 1 }, device: LAPTOP } }), cfg)).status).toBe(403);
    // The token is bound to the visitor: another IP must solve its own challenge.
    expect((await handleFreeTier(req('screen', { body: {}, token: body.token, ip: '198.51.100.1' }), cfg)).status).toBe(401);
    expect((await handleFreeTier(req('screen', { body: {}, token: `${body.token}x` }), cfg)).status).toBe(401);
  });

  it('accepts only the shapes Omigator sends', async () => {
    const cfg = setup();
    const { body } = await session(cfg);
    const send = (action: string, b: unknown) => handleFreeTier(req(action, { body: b, token: body.token }), cfg);
    expect((await send('screen', { candidate: { gse: 'GSE1' }, criteria: [] })).status).toBe(400);
    expect((await send('screen', { candidate: { gse: 'not-a-gse' }, criteria })).status).toBe(400);
    expect((await send('screen', { candidate: { gse: 'GSE1', organisms: '<script>' }, criteria })).status).toBe(400);
    expect((await send('screen', { candidate: { gse: 'GSE1' }, criteria: [{ ...criteria[0], text: 'x'.repeat(401) }] })).status).toBe(400);
    expect((await send('draft', { intent: 'y'.repeat(601) })).status).toBe(400);
    expect((await send('chat', { messages: [] })).status).toBe(404);
  });

  it('stops at the daily quota, and refuses repeats without asking the database again', async () => {
    const cfg = setup();
    let calls = 0;
    const counting = cfg.store;
    cfg.store = { incr: (...a) => (calls++, counting.incr(...a)) };
    const { body } = await session(cfg);
    expect(calls).toBe(0); // status, challenge and session never touch the database
    const visitor = visitorOf(body.token);
    await counting.incr(`omigator:q:2026-10-30:${visitor}:explanations`, LIMITS.explanations, 60);
    const explain = () => handleFreeTier(req('explain', { body: { candidate: { gse: 'GSE1' }, criteria }, token: body.token }), cfg);
    const res = await explain();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/20 explanations per day/);
    expect(calls).toBe(1);
    expect((await explain()).status).toBe(429);
    expect(calls).toBe(1);
  });
  it('counts devices behind one network separately', async () => {
    const cfg = setup();
    const laptop = await session(cfg, '192.0.2.10', LAPTOP);
    const phone = await session(cfg, '192.0.2.10', PHONE);
    const again = await session(cfg, '192.0.2.10', LAPTOP);
    expect(visitorOf(laptop.body.token)).not.toBe(visitorOf(phone.body.token));
    expect(visitorOf(laptop.body.token)).toBe(visitorOf(again.body.token));
  });
});
