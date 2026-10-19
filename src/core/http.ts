/** Small HTTP helpers: retries, timeouts, rate limiting and a bounded worker pool. */

export type Fetch = typeof globalThis.fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
  }
}

export class AbortError extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (err as Error)?.name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx. */
  retries?: number;
  fetch?: Fetch;
}

/** fetch with timeout and retries (exponential backoff, honours Retry-After). Throws HttpError on failure. */
export async function request(url: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<Response> {
  const { signal, timeoutMs = 60_000, retries = 3 } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AbortError();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res: Response | undefined;
    let failure: unknown;
    try {
      res = await doFetch(url, { ...init, signal: combined });
    } catch (err) {
      if (signal?.aborted) throw new AbortError();
      failure = err;
    }

    if (res?.ok) return res;

    const retryable = !res || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) {
      if (res) throw new HttpError(res.status, await res.text().catch(() => ''), url);
      throw new Error(`Network error for ${new URL(url).host}: ${(failure as Error)?.message ?? failure}`);
    }

    const retryAfter = Number(res?.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** attempt;
    await sleep(wait, signal);
  }
}

/** Spaces out calls so that at most one starts per `intervalMs`. */
export class RateLimiter {
  private next = 0;
  constructor(public intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.intervalMs;
    if (slot > now) await sleep(slot - now, signal);
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new AbortError();
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out;
}

/** Hex SHA-256 (Web Crypto; available in browsers and Node ≥ 20). */
export async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
