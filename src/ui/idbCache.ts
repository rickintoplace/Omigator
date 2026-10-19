/**
 * Browser cache for GEO records and model answers (IndexedDB). Rerunning a protocol, or rerunning
 * after editing one criterion, only pays for what changed. Falls back to no caching when IndexedDB
 * is unavailable.
 */

import { type Cache, noCache } from '../core';

const DB = 'omigator';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function createIdbCache(): Promise<Cache> {
  try {
    const db = await open();
    return {
      get: async <T>(key: string) => (await tx(db, 'readonly', (s) => s.get(key)).catch(() => undefined)) as T | undefined,
      set: async (key, value) => {
        await tx(db, 'readwrite', (s) => s.put(value, key)).catch(() => undefined);
      },
    };
  } catch {
    return noCache;
  }
}

export async function clearIdbCache(): Promise<void> {
  try {
    const db = await open();
    // Keep saved runs; clear only cached GEO records and model answers.
    const keys = (await tx(db, 'readonly', (s) => s.getAllKeys())) as string[];
    for (const k of keys.filter((k) => !String(k).startsWith('run:') && k !== 'runs:index')) await tx(db, 'readwrite', (s) => s.delete(k));
  } catch {
    /* nothing to clear */
  }
}

/** Saved runs: every finished run is kept locally so a reload or misclick loses nothing. */
export interface SavedRunMeta {
  id: string;
  createdAt: string;
  intent: string;
  count: number;
  include: number;
  model: string;
}

const MAX_RUNS = 20;

async function kv(): Promise<IDBDatabase | undefined> {
  try {
    return await open();
  } catch {
    return undefined;
  }
}

export async function saveRun(meta: SavedRunMeta, data: unknown): Promise<void> {
  const db = await kv();
  if (!db) return;
  const index = ((await tx(db, 'readonly', (s) => s.get('runs:index')).catch(() => undefined)) as SavedRunMeta[] | undefined) ?? [];
  const next = [meta, ...index.filter((m) => m.id !== meta.id)];
  for (const old of next.slice(MAX_RUNS)) await tx(db, 'readwrite', (s) => s.delete(`run:${old.id}`)).catch(() => undefined);
  await tx(db, 'readwrite', (s) => s.put(data, `run:${meta.id}`)).catch(() => undefined);
  await tx(db, 'readwrite', (s) => s.put(next.slice(0, MAX_RUNS), 'runs:index')).catch(() => undefined);
}

export async function listRuns(): Promise<SavedRunMeta[]> {
  const db = await kv();
  if (!db) return [];
  return ((await tx(db, 'readonly', (s) => s.get('runs:index')).catch(() => undefined)) as SavedRunMeta[] | undefined) ?? [];
}

export async function getRun<T>(id: string): Promise<T | undefined> {
  const db = await kv();
  if (!db) return undefined;
  return (await tx(db, 'readonly', (s) => s.get(`run:${id}`)).catch(() => undefined)) as T | undefined;
}
