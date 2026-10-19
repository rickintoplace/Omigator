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
    await tx(db, 'readwrite', (s) => s.clear());
  } catch {
    /* nothing to clear */
  }
}
