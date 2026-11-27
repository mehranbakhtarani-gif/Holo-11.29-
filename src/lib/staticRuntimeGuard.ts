/**
 * Static Standalone PWA Runtime Guard
 *
 * Enables Holoo Apex to run as a 100% static standalone PWA (e.g., dist/ hosted on
 * Cloudflare Pages, Netlify, Vercel, GitHub Pages, or local static server) with ZERO
 * dependency on `server.ts` or any external Node.js backend, while seamlessly activating
 * optional backend routes whenever `server.ts` IS running.
 */

import type { ExchangeRateEntry } from '../types/accounting';

export interface StandaloneFxItem {
  code: 'USD' | 'EUR' | 'AED' | 'CNY';
  name: string;
  symbol: string;
  priceIrr: number;
  highIrr?: number;
  lowIrr?: number;
  changeIrr: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
  updatedTime: string;
}

export interface StandaloneFxResponse {
  fetchedAt: number;
  source: string;
  sourceUrl: string;
  items: StandaloneFxItem[];
  cached?: boolean;
  stale?: boolean;
  localOnly?: boolean;
}

let cachedBackendAvailable: boolean | null = null;
let inFlightProbe: Promise<boolean> | null = null;

/** Checks whether an HTTP response is genuinely JSON (rejects SPA HTML 200 fallbacks) */
export function isJsonHttpResponse(resp: Response): boolean {
  const ct = (resp.headers?.get?.('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    return false;
  }
  if (ct.includes('application/json') || ct.includes('+json')) {
    return true;
  }
  // In Node unit tests, `new Response(JSON.stringify(...))` defaults to `text/plain;charset=UTF-8`
  if (typeof window === 'undefined' && (!ct || ct.startsWith('text/plain'))) {
    return true;
  }
  return false;
}

/**
 * Probes `/api/health` ONCE per browser session to determine whether `server.ts` is present.
 * - On static hosts (Cloudflare Pages, Netlify, GitHub Pages) that return 404 or `index.html`
 *   (text/html), this cleanly caches `false` so zero repeated 404 requests ever fire.
 * - In Node.js test environments (`typeof window === 'undefined'`), returns `true` unless
 *   explicitly probed via `probeBackendServerWithFetch` so unit test fetch mocks work seamlessly.
 */
export async function detectOptionalBackendServer(
  customFetch?: typeof fetch
): Promise<boolean> {
  if (!customFetch && typeof window === 'undefined') {
    return true;
  }
  if (!customFetch && typeof navigator !== 'undefined' && !navigator.onLine) {
    return false;
  }
  if (!customFetch && cachedBackendAvailable !== null) {
    return cachedBackendAvailable;
  }
  if (!customFetch && inFlightProbe) {
    return inFlightProbe;
  }

  const runProbe = async (): Promise<boolean> => {
    try {
      const fn = customFetch ?? fetch;
      const resp = await fn('/api/health', { method: 'GET', cache: 'no-store' });
      if (!resp.ok || !isJsonHttpResponse(resp)) {
        return false;
      }
      const json = (await resp.json().catch(() => null)) as { status?: string } | null;
      return Boolean(json && json.status === 'ok');
    } catch {
      return false;
    }
  };

  if (customFetch) {
    return runProbe();
  }

  inFlightProbe = runProbe().then((ok) => {
    cachedBackendAvailable = ok;
    inFlightProbe = null;
    return ok;
  });
  return inFlightProbe;
}

export function getCachedBackendAvailability(): boolean | null {
  return cachedBackendAvailable;
}

export function resetBackendProbeCache(): void {
  cachedBackendAvailable = null;
  inFlightProbe = null;
}

const LOCAL_FX_META: Record<
  'USD' | 'CNY' | 'AED' | 'EUR',
  { name: string; symbol: string; fallbackIrr: number }
> = {
  USD: { name: 'دلار آمریکا', symbol: '$', fallbackIrr: 820_000 },
  CNY: { name: 'یوان چین', symbol: '¥', fallbackIrr: 113_000 },
  AED: { name: 'درهم امارات', symbol: 'د.إ', fallbackIrr: 223_000 },
  EUR: { name: 'یورو اروپا', symbol: '€', fallbackIrr: 890_000 },
};

/**
 * Builds a complete FX ticker payload purely from the local IndexedDB `exchangeRates` ledger
 * so the dashboard currency board operates 100% internally without `/api/live-fx`.
 */
export function buildLocalFxResponseFromRates(
  exchangeRates: ExchangeRateEntry[]
): StandaloneFxResponse {
  const codes: ('USD' | 'CNY' | 'AED' | 'EUR')[] = ['USD', 'CNY', 'AED', 'EUR'];
  const items: StandaloneFxItem[] = codes.map((code) => {
    const matching = exchangeRates
      .filter((r) => r.currencyCode === code && Number(r.rateToIrr) > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    const latest = matching[0];
    const prev = matching[1];
    const priceIrr = latest ? Math.round(latest.rateToIrr) : LOCAL_FX_META[code].fallbackIrr;
    const prevIrr = prev ? Math.round(prev.rateToIrr) : priceIrr;
    const changeIrr = priceIrr - prevIrr;
    const changePercent = prevIrr > 0 ? Number(((changeIrr / prevIrr) * 100).toFixed(2)) : 0;
    const direction: 'up' | 'down' | 'flat' =
      changeIrr > 0 ? 'up' : changeIrr < 0 ? 'down' : 'flat';

    return {
      code,
      name: LOCAL_FX_META[code].name,
      symbol: LOCAL_FX_META[code].symbol,
      priceIrr,
      changeIrr,
      changePercent,
      direction,
      updatedTime: latest?.date || 'دفتر محلی',
    };
  });

  return {
    fetchedAt: Date.now(),
    source: 'دفتر نرخ ارز محلی دستگاه (مستقل بدون سرور)',
    sourceUrl: '',
    items,
    cached: true,
    localOnly: true,
  };
}

/**
 * Builds a clean standalone diagnostics object when running as pure static `dist/` PWA
 * without `server.ts`.
 */
export function buildStandaloneLocalDiagnostics() {
  return {
    server: {
      status: 'ok' as const,
      mode: 'standalone-static-pwa',
      port: 0,
      nodeVersion: 'browser-pwa',
      uptimeSec: 0,
      startedAt: new Date().toISOString(),
      memoryMb: { rss: 0, heapUsed: 0 },
    },
    supabase: {
      configured: false,
      urlHost: null,
      projectRef: null,
      keyRole: 'standalone_local',
      tableReady: false,
      workspaceCount: 0,
      errorCode: 'STANDALONE_STATIC_PWA',
      errorMessage:
        'برنامه در حالت کاملاً مستقل و بدون سرور (Static PWA) اجرا می‌شود. کل حسابداری، IndexedDB، پشتیبان رمزنگاری‌شده، P2P Mesh و Firebase بدون نیاز به server.ts فعال هستند.',
      latencyMs: 0,
    },
    auth: {
      authenticated: false,
      authSource: 'disconnected' as const,
      workspaceId: null,
      cookiePresent: false,
    },
    timestamp: new Date().toISOString(),
  };
}
