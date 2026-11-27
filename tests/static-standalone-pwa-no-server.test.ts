import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHolooSeedData } from '../src/data/holooSeed';
import {
  buildLocalFxResponseFromRates,
  buildStandaloneLocalDiagnostics,
  detectOptionalBackendServer,
  isJsonHttpResponse,
  resetBackendProbeCache,
} from '../src/lib/staticRuntimeGuard';
import { localCopilotRespond } from '../src/lib/localSmallLlm';
import { buildCopilotFinancialSnapshot } from '../src/lib/smartIntelligence';
import { computePartyBalances, computeTrialBalance } from '../src/lib/accountingEngine';

const ROOT = process.cwd();
let passed = 0;

async function runCase(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
  await runCase('1. detectOptionalBackendServer accurately rejects HTML SPA 200 fallbacks, 404s, and network errors', async () => {
    resetBackendProbeCache();

    // Cloudflare Pages / Netlify SPA fallback returns HTTP 200 with text/html index.html
    const spaHtmlFetch = (async () =>
      new Response('<!doctype html><html><body>Holoo Apex</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch;
    assert.equal(await detectOptionalBackendServer(spaHtmlFetch), false);

    // Classic static server 404
    const notFoundFetch = (async () =>
      new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      })) as unknown as typeof fetch;
    assert.equal(await detectOptionalBackendServer(notFoundFetch), false);

    // Network offline exception
    const offlineFetch = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;
    assert.equal(await detectOptionalBackendServer(offlineFetch), false);

    // Real Express server.ts JSON health endpoint returns true
    const realServerFetch = (async () =>
      new Response(JSON.stringify({ status: 'ok', service: 'holoo-apex-server' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })) as unknown as typeof fetch;
    assert.equal(await detectOptionalBackendServer(realServerFetch), true);
  });

  await runCase('2. isJsonHttpResponse strictly differentiates JSON API payloads from HTML SPA fallbacks', () => {
    const htmlResp = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    const jsonResp = new Response('{}', { headers: { 'content-type': 'application/json' } });
    assert.equal(isJsonHttpResponse(htmlResp), false);
    assert.equal(isJsonHttpResponse(jsonResp), true);
  });

  await runCase('3. buildLocalFxResponseFromRates computes USD/CNY/AED/EUR rates 100% locally without /api/live-fx', () => {
    const fx = buildLocalFxResponseFromRates([
      { id: 'r1', ownerId: 'u1', currencyCode: 'USD', date: '1404/03/01', rateToIrr: 800_000, rateType: 'market' },
      { id: 'r2', ownerId: 'u1', currencyCode: 'USD', date: '1404/03/05', rateToIrr: 840_000, rateType: 'market' },
      { id: 'r3', ownerId: 'u1', currencyCode: 'EUR', date: '1404/03/05', rateToIrr: 910_000, rateType: 'market' },
    ]);
    assert.equal(fx.localOnly, true);
    assert.equal(fx.items.length, 4);
    const usd = fx.items.find((i) => i.code === 'USD')!;
    assert.equal(usd.priceIrr, 840_000);
    assert.equal(usd.changeIrr, 40_000);
    assert.equal(usd.direction, 'up');
    assert.equal(usd.changePercent, 5);
  });

  await runCase('4. buildStandaloneLocalDiagnostics & localCopilotRespond operate 100% internally without server.ts', () => {
    const diag = buildStandaloneLocalDiagnostics();
    assert.equal(diag.server.status, 'ok');
    assert.equal(diag.server.mode, 'standalone-static-pwa');
    assert.equal(diag.supabase.errorCode, 'STANDALONE_STATIC_PWA');

    const seed = createHolooSeedData('u_static');
    const tb = computeTrialBalance(seed.accounts, seed.vouchers);
    const partyBalances = computePartyBalances(seed.parties, seed.vouchers);
    const snapshot = buildCopilotFinancialSnapshot({
      companyName: 'شرکت پارس نخ',
      fiscalYear: '1404',
      currencyUnit: 'IRR',
      liquidity: 660_000_000,
      netSales: 900_000_000,
      grossProfit: 600_000_000,
      netProfit: 520_000_000,
      grossMarginPct: 66.7,
      netMarginPct: 57.8,
      totalAssets: 2_000_000_000,
      totalLiabilities: 600_000_000,
      totalEquity: 1_400_000_000,
      trialBalance: tb,
      products: seed.products,
      parties: seed.parties,
      partyBalances,
      cheques: seed.cheques,
      vouchers: seed.vouchers,
      invoices: seed.invoices,
      auditScore: 98,
      auditErrors: 0,
      auditWarnings: 1,
    });
    const aiRes = localCopilotRespond({
      message: 'موجودی انبار و چک‌ها چطور است؟',
      snapshot,
    });
    assert.ok(aiRes.reply.length > 20);
  });

  await runCase('5. Static zero-server PWA deployment configs (_redirects & vercel.json) are present', () => {
    const redirects = fs.readFileSync(path.join(ROOT, 'public/_redirects'), 'utf8');
    assert.ok(redirects.includes('/* /index.html 200'));
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')) as {
      rewrites?: Array<{ source: string; destination: string }>;
    };
    assert.ok(Array.isArray(vercel.rewrites) && vercel.rewrites[0]?.destination === '/index.html');
  });

  console.log(`\nAll ${passed} Zero-Server Static Standalone PWA tests passed!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
