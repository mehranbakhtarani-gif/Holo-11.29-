/**
 * Versioned snapshot boundary for durable business/configuration data still
 * held in legacy localStorage. Only explicit allowlisted keys are captured;
 * credentials, PIN material, device identity and presentation preferences are
 * intentionally excluded.
 *
 * Restore is replay-safe: all values are validated before the first mutation,
 * and every write is idempotent so the durable restore journal can retry after
 * a crash between localStorage writes.
 */
export interface BusinessLocalStateSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  stores: Record<string, string>;
}

export const BUSINESS_LOCAL_STATE_KEYS = [
  'holoo_apex96_workspace_extensions_v2',
  'holoo_apex96_favorite_menus',
  'holoo_apex96_product_meta_v1',
  'holoo_apex96_reserved_invoices_v1',
  'holoo_apex_voucher_templates_v1',
  'holoo_apex_voucher_template_usage_v1',
  'holoo_apex_bank_recon_sessions_v1',
  'holoo_apex_warehouse_transfers_v1',
  'holoo_apex_invoice_settings_v1',
  'holoo_apex_sync_conflict_default_v1',
  'holoo_apex_conflict_policy_v1',
  'holoo_apex_offline_outbox_v1',
  'holoo_apex_supabase_revision_v1',
  'holoo_apex_supabase_last_sync_v1',
  'holoo_apex_supabase_workspace_id_v1',
  'holoo_apex_supabase_auto_backup_v1',
] as const;

type BusinessLocalStateKey = (typeof BUSINESS_LOCAL_STATE_KEYS)[number];

const JSON_KEYS = new Set<string>([
  'holoo_apex96_workspace_extensions_v2',
  'holoo_apex96_favorite_menus',
  'holoo_apex96_product_meta_v1',
  'holoo_apex96_reserved_invoices_v1',
  'holoo_apex_voucher_templates_v1',
  'holoo_apex_voucher_template_usage_v1',
  'holoo_apex_bank_recon_sessions_v1',
  'holoo_apex_warehouse_transfers_v1',
  'holoo_apex_invoice_settings_v1',
  'holoo_apex_offline_outbox_v1',
]);

const MAX_STORE_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const REVIEW_STATUSES = new Set([
  'pending_review',
  'confirmed',
  'rejected',
  'adjusted',
  'duplicate_ignored',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonStore(key: string, raw: string): unknown {
  if (!JSON_KEYS.has(key)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`داده ذخیره‌شده «${key}» JSON معتبر نیست.`);
  }
}

function validateExtensionState(value: unknown): void {
  if (!isRecord(value)) throw new Error('ساختار افزونه‌های فضای کاری معتبر نیست.');
  const arrayFields = [
    'reservedInvoices', 'favoriteMenus', 'pettyCashItems', 'recurringTemplates',
    'bankLoans', 'dyeLots', 'warehouseSlips', 'bomFormulas', 'installmentPlans',
    'volumeDiscountRules', 'fiscalArchives', 'warehouseTransfers',
  ];
  for (const field of arrayFields) {
    if (value[field] !== undefined && !Array.isArray(value[field])) {
      throw new Error(`فیلد افزونه «${field}» باید آرایه باشد.`);
    }
  }
  for (const field of ['productMetaMap', 'moadianLinks']) {
    if (value[field] !== undefined && !isRecord(value[field])) {
      throw new Error(`فیلد افزونه «${field}» باید شیء باشد.`);
    }
  }
  if (value.pettyCashCeilingIrr !== undefined &&
      (typeof value.pettyCashCeilingIrr !== 'number' ||
       !Number.isFinite(value.pettyCashCeilingIrr) || value.pettyCashCeilingIrr < 0)) {
    throw new Error('سقف تنخواه در snapshot معتبر نیست.');
  }
  if (Array.isArray(value.warehouseTransfers) &&
      (value.warehouseTransfers.length > 250 || !value.warehouseTransfers.every((entry) =>
        isRecord(entry) && typeof entry.id === 'string' && entry.id.trim().length > 0 &&
        typeof entry.productId === 'string' && entry.productId.trim().length > 0 &&
        typeof entry.fromWarehouse === 'string' && typeof entry.toWarehouse === 'string' &&
        typeof entry.qty === 'number' && Number.isFinite(entry.qty) && entry.qty > 0 &&
        ['in_transit', 'received', 'cancelled'].includes(String(entry.status))))) {
    throw new Error('انتقال‌های بین انبار در snapshot افزونه‌های فضای کاری ناقص یا نامعتبرند.');
  }
  if (Array.isArray(value.favoriteMenus) &&
      !value.favoriteMenus.every((entry) => typeof entry === 'string')) {
    throw new Error('فهرست منوهای منتخب معتبر نیست.');
  }
}

function validateBankSessions(value: unknown): void {
  if (!isRecord(value)) throw new Error('ساختار تصمیم‌های تطبیق بانکی معتبر نیست.');
  for (const [bankCode, entries] of Object.entries(value)) {
    if (!bankCode || ['__proto__', 'constructor', 'prototype'].includes(bankCode) || !isRecord(entries)) {
      throw new Error('حساب یا مجموعه ردیف‌های تطبیق بانکی معتبر نیست.');
    }
    for (const [rowId, decision] of Object.entries(entries)) {
      if (!rowId || ['__proto__', 'constructor', 'prototype'].includes(rowId) || !isRecord(decision) ||
          typeof decision.statementRowId !== 'string' ||
          !REVIEW_STATUSES.has(String(decision.reviewStatus))) {
        throw new Error('یکی از تصمیم‌های تطبیق بانکی ناقص یا نامعتبر است.');
      }
      if (decision.linkedVoucherNumber !== undefined &&
          (typeof decision.linkedVoucherNumber !== 'number' || !Number.isFinite(decision.linkedVoucherNumber))) {
        throw new Error('شماره سند متصل در تصمیم تطبیق بانکی معتبر نیست.');
      }
    }
  }
}

function validateStore(key: string, raw: string): void {
  if (typeof raw !== 'string' || raw.length > MAX_STORE_CHARS) {
    throw new Error(`حجم داده ذخیره‌شده «${key}» خارج از محدوده مجاز است.`);
  }
  const value = parseJsonStore(key, raw);
  switch (key) {
    case 'holoo_apex96_workspace_extensions_v2':
      validateExtensionState(value);
      break;
    case 'holoo_apex96_favorite_menus':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error('ساختار منوهای منتخب معتبر نیست.');
      }
      break;
    case 'holoo_apex96_product_meta_v1':
    case 'holoo_apex_voucher_template_usage_v1':
    case 'holoo_apex_invoice_settings_v1':
      if (!isRecord(value)) throw new Error(`ساختار داده «${key}» معتبر نیست.`);
      break;
    case 'holoo_apex96_reserved_invoices_v1':
    case 'holoo_apex_offline_outbox_v1':
      if (!Array.isArray(value)) throw new Error(`ساختار داده «${key}» باید آرایه باشد.`);
      break;
    case 'holoo_apex_voucher_templates_v1':
      if (!Array.isArray(value) || !value.every((entry) =>
        isRecord(entry) && typeof entry.id === 'string' &&
        typeof entry.name === 'string' && Array.isArray(entry.lines))) {
        throw new Error('الگوهای سفارشی سند حسابداری ناقص یا نامعتبرند.');
      }
      break;
    case 'holoo_apex_bank_recon_sessions_v1':
      validateBankSessions(value);
      break;
    case 'holoo_apex_warehouse_transfers_v1':
      if (!Array.isArray(value) || value.length > 200 || !value.every((entry) =>
        isRecord(entry) && typeof entry.id === 'string' &&
        typeof entry.productId === 'string' &&
        typeof entry.fromWarehouse === 'string' &&
        typeof entry.toWarehouse === 'string' &&
        typeof entry.qty === 'number' && Number.isFinite(entry.qty) &&
        ['in_transit', 'received', 'cancelled'].includes(String(entry.status)))) {
        throw new Error('انتقال‌های بین انبار ناقص یا نامعتبرند.');
      }
      break;
    case 'holoo_apex_sync_conflict_default_v1':
      if (!['ask', 'keep_local', 'restore_remote'].includes(raw)) {
        throw new Error('سیاست پیش‌فرض حل تعارض همگام‌سازی معتبر نیست.');
      }
      break;
    case 'holoo_apex_conflict_policy_v1':
      if (!['last_write_wins', 'first_write_wins'].includes(raw)) {
        throw new Error('سیاست تعارض فضای ابری معتبر نیست.');
      }
      break;
    case 'holoo_apex_supabase_revision_v1':
      if (!/^\d+$/.test(raw)) throw new Error('شماره بازبینی همگام‌سازی معتبر نیست.');
      break;
    case 'holoo_apex_supabase_auto_backup_v1':
      if (raw !== '0' && raw !== '1') throw new Error('تنظیم پشتیبان‌گیری خودکار معتبر نیست.');
      break;
    case 'holoo_apex_supabase_workspace_id_v1':
      if (!raw.trim() || raw.length > 180) throw new Error('شناسه فضای کاری همگام‌سازی معتبر نیست.');
      break;
    case 'holoo_apex_supabase_last_sync_v1':
      if (raw.length > 120) throw new Error('نشانگر آخرین همگام‌سازی معتبر نیست.');
      break;
  }
}

export function validateBusinessLocalStateSnapshot(
  value: unknown
): BusinessLocalStateSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) ||
      !isRecord(value.stores)) {
    throw new Error('ساختار snapshot داده‌های تجاری محلی معتبر نیست.');
  }
  const stores = value.stores;
  let totalChars = 0;
  for (const [key, raw] of Object.entries(stores)) {
    if (!(BUSINESS_LOCAL_STATE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`کلید ذخیره‌سازی خارج از فهرست مجاز است: ${key}`);
    }
    if (typeof raw !== 'string') throw new Error(`مقدار ذخیره‌شده «${key}» باید متن باشد.`);
    validateStore(key, raw);
    totalChars += raw.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    throw new Error('حجم مجموع داده‌های تجاری محلی از سقف snapshot بیشتر است.');
  }
  return value as unknown as BusinessLocalStateSnapshot;
}

export function captureBusinessLocalStateSnapshot(): BusinessLocalStateSnapshot {
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('ذخیره‌سازی محلی برای تهیه snapshot در دسترس نیست.');
  }
  const stores: Record<string, string> = {};
  for (const key of BUSINESS_LOCAL_STATE_KEYS) {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      validateStore(key, raw);
      stores[key] = raw;
    }
  }
  return validateBusinessLocalStateSnapshot({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    stores,
  });
}

function countNestedRecords(value: unknown, depth = 0): number {
  if (depth > 8 || value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.length + value.reduce((sum, entry) => sum + countNestedRecords(entry, depth + 1), 0);
  }
  return Object.entries(value as Record<string, unknown>)
    .reduce((sum, [, entry]) => sum + 1 + countNestedRecords(entry, depth + 1), 0);
}

export function countBusinessLocalStateSnapshotRecords(value: BusinessLocalStateSnapshot): number {
  const snapshot = validateBusinessLocalStateSnapshot(value);
  return Object.entries(snapshot.stores).reduce((sum, [key, raw]) => {
    return sum + 1 + (JSON_KEYS.has(key) ? countNestedRecords(JSON.parse(raw)) : 0);
  }, 0);
}

/**
 * Apply the complete allowlisted set. The caller must hold the restore barrier
 * and a durable commit-intent journal. Replaying after a crash is safe.
 */
export function restoreBusinessLocalStateSnapshot(value: BusinessLocalStateSnapshot): void {
  const snapshot = validateBusinessLocalStateSnapshot(value);
  if (typeof window === 'undefined' || !window.localStorage) {
    throw new Error('ذخیره‌سازی محلی برای بازیابی داده‌های تجاری در دسترس نیست.');
  }
  const storage = window.localStorage;
  // Clear the allowlist first so absent keys in a full snapshot cannot leave stale data.
  for (const key of BUSINESS_LOCAL_STATE_KEYS) storage.removeItem(key);
  for (const key of BUSINESS_LOCAL_STATE_KEYS) {
    const raw = snapshot.stores[key as BusinessLocalStateKey];
    if (raw !== undefined) storage.setItem(key, raw);
  }
}
