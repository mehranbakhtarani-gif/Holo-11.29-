/**
 * Unified Smart Global Search Engine (100% Local & Instant)
 * Indexes EVERY node of HOLOO_MENU_TREE alongside vouchers, invoices, accounts,
 * parties, products/inventory, Sayadi cheques, and currencies with strict Persian
 * fuzzy matching, spoken number normalization, and category filtering.
 */

import type {
  Account,
  ActiveModule,
  Cheque,
  CurrencyDefinition,
  CurrencyUnit,
  Invoice,
  Party,
  Product,
  TrialBalanceRow,
  Voucher,
} from '../types/accounting';
import { fuzzyScoreFields, normalizeFuzzyText } from './fuzzySearch';
import { normalizeSpokenPersianNumbers } from './financialVoiceSearch';
import { getIndexedHolooMenus } from './holooMenuTree';
import { formatCompactMoney, formatMoney, formatWeight, toPersianDigits } from './format';

export type SmartSearchCategory =
  | 'all'
  | 'menu'
  | 'invoice'
  | 'voucher'
  | 'account'
  | 'party'
  | 'product'
  | 'cheque'
  | 'currency';

export interface SmartSearchResultItem {
  id: string;
  category: Exclude<SmartSearchCategory, 'all'>;
  categoryLabel: string;
  title: string;
  subtitle: string;
  metaText?: string;
  metaTone?: 'default' | 'positive' | 'negative' | 'warning';
  shortcut?: string;
  score: number;
  isFuzzy?: boolean;
  module: ActiveModule;
  intent?: string;
  subKey?: string;
}

export interface SmartGlobalSearchDataset {
  accounts: Account[];
  parties: Party[];
  products: Product[];
  vouchers: Voucher[];
  cheques: Cheque[];
  invoices: Invoice[];
  currencies: CurrencyDefinition[];
  trialBalance: TrialBalanceRow[];
  partyBalances: Map<string, number>;
  unit: CurrencyUnit;
}

export interface SmartGlobalSearchResponse {
  normalizedQuery: string;
  results: SmartSearchResultItem[];
  counts: Record<SmartSearchCategory, number>;
}

const ACCOUNT_LEVEL_LABELS: Record<string, string> = {
  group: 'گروه حساب',
  kol: 'حساب کل',
  moein: 'حساب معین',
  tafsili: 'حساب تفصیلی',
};

const INVOICE_TYPE_LABELS: Record<string, string> = {
  sale: 'فاکتور فروش رسمی',
  purchase: 'فاکتور خرید',
  proforma: 'پیش‌فاکتور',
  sale_return: 'برگشت از فروش',
  purchase_return: 'برگشت از خرید',
  waste: 'ضایعات انبار',
};

const EMPTY_COUNTS: Record<SmartSearchCategory, number> = {
  all: 0,
  menu: 0,
  invoice: 0,
  voucher: 0,
  account: 0,
  party: 0,
  product: 0,
  cheque: 0,
  currency: 0,
};

const MENU_FILLER_TOKENS = new Set([
  'منو',
  'منوی',
  'منوها',
  'بخش',
  'صفحه',
  'ماژول',
  'برو',
  'به',
  'باز',
  'کن',
  'نمایش',
  'نشان',
  'بده',
  'لطفا',
  'لطفاً',
]);

function stripLeadingCommandFillers(query: string): string {
  const tokens = normalizeSpokenPersianNumbers(query).split(' ').filter(Boolean);
  const meaningful = tokens.filter((t) => !MENU_FILLER_TOKENS.has(t));
  return meaningful.length > 0 ? meaningful.join(' ') : tokens.join(' ');
}

export function executeSmartGlobalSearch(
  rawQuery: string,
  dataset: SmartGlobalSearchDataset,
  options?: {
    category?: SmartSearchCategory;
    maxResults?: number;
  }
): SmartGlobalSearchResponse {
  const activeCategory = options?.category ?? 'all';
  const maxResults = options?.maxResults ?? 28;
  const menus = getIndexedHolooMenus();

  const normalizedQuery = normalizeFuzzyText(rawQuery);
  const effectiveQuery = stripLeadingCommandFillers(rawQuery);

  // Empty query -> return curated menu tree shortcuts (all menus if 'menu' filter is selected)
  if (!normalizedQuery) {
    const menuItems: SmartSearchResultItem[] = menus.map((m, idx) => ({
      id: `menu-${m.key}`,
      category: 'menu',
      categoryLabel: m.groupLabel,
      title: m.label,
      subtitle: m.breadcrumb,
      shortcut: m.shortcut,
      score: 100 - idx * 0.1,
      module: m.module,
      intent: m.intent,
      subKey: m.key,
    }));

    const counts: Record<SmartSearchCategory, number> = {
      ...EMPTY_COUNTS,
      all: menuItems.length,
      menu: menuItems.length,
    };

    const filtered =
      activeCategory === 'all' || activeCategory === 'menu'
        ? menuItems.slice(0, activeCategory === 'menu' ? menus.length : 14)
        : [];

    return {
      normalizedQuery: '',
      results: filtered,
      counts,
    };
  }

  const allMatches: SmartSearchResultItem[] = [];
  const trialBalanceMap = new Map<string, number>();
  for (const row of dataset.trialBalance) {
    trialBalanceMap.set(row.accountCode, row.balanceDebit - row.balanceCredit);
  }

  const queryMentionsMenuWord = normalizedQuery
    .split(' ')
    .some((tok) => tok === 'منو' || tok === 'منوی' || tok === 'بخش' || tok === 'صفحه');

  // 1. ALL items in HOLOO_MENU_TREE
  for (const m of menus) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: m.label, weight: 1.5 },
      { text: m.groupLabel, weight: 1.15 },
      { text: m.keywords, weight: 1.1 },
      { text: m.shortcut, weight: 1.35 },
      { text: m.key, weight: 0.7 },
    ]);
    if (res.score > 0) {
      allMatches.push({
        id: `menu-${m.key}`,
        category: 'menu',
        categoryLabel: `منو · ${m.groupLabel}`,
        title: m.label,
        subtitle: m.breadcrumb,
        shortcut: m.shortcut,
        score: res.score + (queryMentionsMenuWord ? 18 : 6),
        isFuzzy: res.isFuzzy,
        module: m.module,
        intent: m.intent,
        subKey: m.key,
      });
    }
  }

  // 2. Accounting Vouchers
  for (const v of dataset.vouchers) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: String(v.voucherNumber), weight: 1.5 },
      { text: `سند ${v.voucherNumber}`, weight: 1.35 },
      { text: v.description, weight: 1.25 },
      { text: v.date, weight: 1.0 },
      {
        text: v.lines.map((l) => `${l.accountCode} ${l.accountTitle} ${l.partyName || ''}`).join(' '),
        weight: 0.95,
      },
    ]);
    if (res.score > 0) {
      allMatches.push({
        id: `voucher-${v.id}`,
        category: 'voucher',
        categoryLabel: 'سند حسابداری',
        title: `سند #${toPersianDigits(v.voucherNumber)} — ${v.description}`,
        subtitle: `${toPersianDigits(v.date)} · ${v.status === 'permanent' ? 'دائم و قطعی' : 'موقت'} · ${toPersianDigits(v.lines.length)} آرتیکل`,
        metaText: formatCompactMoney(v.totalDebit, dataset.unit),
        metaTone: 'default',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'vouchers',
        subKey: 'voucher-list',
      });
    }
  }

  // 3. Invoices & Proformas
  for (const inv of dataset.invoices) {
    const typeLabel = INVOICE_TYPE_LABELS[inv.invoiceType] || inv.invoiceType;
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: inv.invoiceNumber, weight: 1.5 },
      { text: inv.partyName, weight: 1.3 },
      { text: typeLabel, weight: 1.05 },
      { text: inv.taxSerial, weight: 1.1 },
      { text: inv.date, weight: 1.0 },
      { text: String(inv.grandTotal), weight: 0.8 },
      {
        text: inv.items.map((it) => `${it.sku} ${it.productName} ${it.lotNumber || ''}`).join(' '),
        weight: 0.95,
      },
    ]);
    if (res.score > 0) {
      allMatches.push({
        id: `invoice-${inv.id}`,
        category: 'invoice',
        categoryLabel: inv.invoiceType === 'proforma' ? 'پیش‌فاکتور' : 'فاکتور',
        title: `${toPersianDigits(inv.invoiceNumber)} — ${inv.partyName}`,
        subtitle: `${typeLabel} · ${toPersianDigits(inv.date)}`,
        metaText: formatMoney(inv.grandTotal, dataset.unit),
        metaTone:
          inv.status === 'settled'
            ? 'positive'
            : inv.status === 'cancelled'
              ? 'negative'
              : 'warning',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'invoices',
        subKey: 'inv-list',
      });
    }
  }

  // 4. Chart of Accounts (with Live Balance)
  for (const a of dataset.accounts) {
    const levelLabel = ACCOUNT_LEVEL_LABELS[a.level] || a.level;
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: a.code, weight: 1.5 },
      { text: a.title, weight: 1.3 },
      { text: levelLabel, weight: 0.75 },
    ]);
    if (res.score > 0) {
      const bal = trialBalanceMap.get(a.code) ?? 0;
      allMatches.push({
        id: `account-${a.id}`,
        category: 'account',
        categoryLabel: 'کدینگ حساب',
        title: `${toPersianDigits(a.code)} — ${a.title}`,
        subtitle: levelLabel,
        metaText:
          bal === 0
            ? 'مانده صفر'
            : `${formatCompactMoney(Math.abs(bal), dataset.unit)} ${bal > 0 ? 'بد' : 'بس'}`,
        metaTone: bal < 0 ? 'positive' : 'default',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'accounts',
        subKey: 'accounts-all',
      });
    }
  }

  // 5. Parties (with Live Balance)
  for (const p of dataset.parties) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: p.code, weight: 1.35 },
      { text: p.name, weight: 1.35 },
      { text: p.nationalId, weight: 1.1 },
      { text: p.phone, weight: 1.0 },
    ]);
    if (res.score > 0) {
      const bal = dataset.partyBalances.get(p.id) ?? 0;
      allMatches.push({
        id: `party-${p.id}`,
        category: 'party',
        categoryLabel: 'طرف‌حساب',
        title: `${toPersianDigits(p.code)} — ${p.name}`,
        subtitle: `${p.nationalId ? `شناسه ${toPersianDigits(p.nationalId)} · ` : ''}${
          p.phone ? toPersianDigits(p.phone) : 'بدون شماره تماس'
        }`,
        metaText:
          bal === 0
            ? 'تسویه'
            : `${formatCompactMoney(Math.abs(bal), dataset.unit)} ${bal > 0 ? 'بد' : 'بس'}`,
        metaTone: bal > 0 ? 'warning' : bal < 0 ? 'positive' : 'default',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'parties',
        subKey: 'parties',
      });
    }
  }

  // 6. Products & Yarn Inventory
  for (const pr of dataset.products) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: pr.sku, weight: 1.4 },
      { text: pr.name, weight: 1.35 },
      { text: pr.yarnCount, weight: 1.15 },
      { text: pr.lotNumber, weight: 1.15 },
      { text: pr.originCountry, weight: 0.95 },
      { text: pr.category, weight: 0.95 },
      { text: pr.warehouse, weight: 0.9 },
    ]);
    if (res.score > 0) {
      const lowStock = pr.stock < pr.reorderPoint;
      allMatches.push({
        id: `product-${pr.id}`,
        category: 'product',
        categoryLabel: 'انبار و کالا',
        title: `${toPersianDigits(pr.sku)} — ${pr.name}`,
        subtitle: `${pr.warehouse}${pr.lotNumber ? ` · لات ${toPersianDigits(pr.lotNumber)}` : ''}`,
        metaText: `${formatWeight(pr.stock)} ${pr.unit}`,
        metaTone: lowStock ? 'negative' : 'positive',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'inventory',
        subKey: 'inv-products',
      });
    }
  }

  // 7. Sayadi Cheques
  for (const c of dataset.cheques) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: c.sayadiId, weight: 1.45 },
      { text: c.serial, weight: 1.3 },
      { text: c.partyName, weight: 1.25 },
      { text: c.bankName, weight: 1.0 },
      { text: c.dueDate, weight: 1.05 },
      { text: String(c.amount), weight: 0.85 },
    ]);
    if (res.score > 0) {
      allMatches.push({
        id: `cheque-${c.id}`,
        category: 'cheque',
        categoryLabel: 'چک صیادی',
        title: `چک صیادی ${toPersianDigits(c.sayadiId)} — ${c.partyName}`,
        subtitle: `سررسید ${toPersianDigits(c.dueDate)} · ${c.bankName} · ${
          c.direction === 'receivable' ? 'دریافتی' : 'پرداختی'
        }`,
        metaText: formatCompactMoney(c.amount, dataset.unit),
        metaTone: c.status === 'bounced' ? 'negative' : c.direction === 'receivable' ? 'positive' : 'warning',
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'treasury',
        intent: `cheque:${c.id}`,
        subKey: 'tr-cheques',
      });
    }
  }

  // 8. Currencies
  for (const cur of dataset.currencies) {
    const res = fuzzyScoreFields(effectiveQuery, [
      { text: cur.code, weight: 1.45 },
      { text: cur.name, weight: 1.3 },
      { text: cur.symbol, weight: 0.9 },
    ]);
    if (res.score > 0) {
      allMatches.push({
        id: `currency-${cur.id}`,
        category: 'currency',
        categoryLabel: 'ارز',
        title: `${cur.code} (${cur.symbol}) — ${cur.name}`,
        subtitle: cur.isBase
          ? 'ارز پایه دفاتر قانونی (نرخ ۱)'
          : `نرخ پیش‌فرض: ${toPersianDigits(cur.defaultRateToIrr.toLocaleString('en-US'))} ریال`,
        score: res.score,
        isFuzzy: res.isFuzzy,
        module: 'currencies',
        intent: 'rates',
        subKey: 'tr-fx-reval',
      });
    }
  }

  allMatches.sort((a, b) => b.score - a.score);

  const counts: Record<SmartSearchCategory, number> = { ...EMPTY_COUNTS };
  counts.all = allMatches.length;
  for (const item of allMatches) {
    counts[item.category] += 1;
  }

  const filtered =
    activeCategory === 'all'
      ? allMatches.slice(0, maxResults)
      : allMatches.filter((m) => m.category === activeCategory).slice(0, maxResults);

  return {
    normalizedQuery,
    results: filtered,
    counts,
  };
}
