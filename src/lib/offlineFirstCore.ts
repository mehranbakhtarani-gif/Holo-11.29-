/**
 * Offline-First PWA Core Engine for Holoo Apex
 *
 * Provides:
 * 1. Cryptographic SHA-256 & 256-bit deterministic snapshot digests (replacing weak 32-bit FNV-1a)
 * 2. AES-256-GCM + PBKDF2-SHA-256 encrypted offline backup export/import with integrity & version checks
 * 3. Duplicate-import guard (prevents re-importing identical backups accidentally)
 * 4. Three independent operating modes: 'local' | 'online' | 'hybrid'
 * 5. Offline-safe local profile passcode hashing (PBKDF2-SHA-256, zero plaintext passwords) & workspace isolation
 * 6. Exponential backoff scheduler for durable outbox retries
 * 7. Storage quota & eviction risk monitor before sensitive financial writes
 * 8. Strict financial conflict guard (prevents silent LWW overwrite of permanent accounting/inventory records)
 */

import { computeDeterministicHash256 } from './moneyMath';
import { safeParseJsonObject } from './localFolderDexieDb';

// ==================== 1. COLLISION-RESISTANT 256-BIT SNAPSHOT DIGESTS ====================

/** Strips volatile export timestamps so identical accounting datasets always hash identically */
export function normalizeSnapshotForHashing(rawJson: string): string {
  return rawJson
    .replace(/"exportedAt"\s*:\s*"[^"]*"/g, '"exportedAt":""')
    .replace(/"mirroredAt"\s*:\s*"[^"]*"/g, '"mirroredAt":""');
}

/**
 * Synchronous 256-bit collision-resistant snapshot digest (64 hex chars + byte length).
 * Used on synchronous React render/mutation hot paths where Web Crypto async APIs cannot block.
 */
export function computeSnapshotDigest256Sync(rawJson: string): string {
  const normalized = normalizeSnapshotForHashing(rawJson);
  return `d256_${normalized.length}_${computeDeterministicHash256(normalized)}`;
}

/**
 * Standard cryptographic SHA-256 hex digest (Web Crypto SubtleCrypto — works 100% offline in
 * modern browsers & Node.js 20+). Falls back cleanly to 256-bit deterministic digest if
 * SubtleCrypto is unavailable in insecure HTTP contexts.
 */
export async function computeSnapshotSha256Hex(rawJson: string): Promise<string> {
  const normalized = normalizeSnapshotForHashing(rawJson);
  const subtle = typeof globalThis !== 'undefined' ? globalThis.crypto?.subtle : undefined;
  if (subtle && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(normalized);
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return computeDeterministicHash256(normalized);
}

// ==================== 2. THREE OPERATING MODES (LOCAL / ONLINE / HYBRID) ====================

export type OperatingMode = 'local' | 'online' | 'hybrid';

const OPERATING_MODE_STORAGE_KEY = 'holoo_apex_operating_mode_v1';

export function loadOperatingMode(): OperatingMode {
  try {
    const raw = localStorage.getItem(OPERATING_MODE_STORAGE_KEY);
    if (raw === 'local' || raw === 'online' || raw === 'hybrid') return raw;
  } catch {
    // ignore storage restriction
  }
  return 'hybrid';
}

export function saveOperatingMode(mode: OperatingMode): void {
  try {
    localStorage.setItem(OPERATING_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

export interface EffectiveModeCapabilities {
  requestedMode: OperatingMode;
  effectiveMode: OperatingMode;
  isOnline: boolean;
  allowLocalWrites: boolean;
  allowCloudPush: boolean;
  allowCloudPull: boolean;
  queueOutboxWhenOffline: boolean;
}

/**
 * Resolves runtime capabilities without ever blocking core local financial writes
 * or deleting local data when transitioning between Local, Online, and Hybrid modes.
 */
export function resolveEffectiveOperatingMode(
  requestedMode: OperatingMode,
  isOnline: boolean
): EffectiveModeCapabilities {
  if (requestedMode === 'local') {
    return {
      requestedMode,
      effectiveMode: 'local',
      isOnline,
      allowLocalWrites: true,
      allowCloudPush: false,
      allowCloudPull: false,
      queueOutboxWhenOffline: false,
    };
  }
  if (requestedMode === 'online') {
    return {
      requestedMode,
      effectiveMode: isOnline ? 'online' : 'local',
      isOnline,
      allowLocalWrites: true,
      allowCloudPush: isOnline,
      allowCloudPull: isOnline,
      queueOutboxWhenOffline: true,
    };
  }
  // hybrid (default Offline-First)
  return {
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    isOnline,
    allowLocalWrites: true,
    allowCloudPush: isOnline,
    allowCloudPull: isOnline,
    queueOutboxWhenOffline: true,
  };
}

// ==================== 3. AES-256-GCM ENCRYPTED OFFLINE BACKUP ENGINE ====================

export const ENCRYPTED_BACKUP_FORMAT = 'holoo-apex-encrypted-backup';
export const ENCRYPTED_BACKUP_SCHEMA_VERSION = 2;
const PBKDF2_ITERATIONS = 600_000;
const IMPORTED_BACKUP_DIGESTS_KEY = 'holoo_apex_imported_backup_digests_v1';

export interface EncryptedBackupEnvelope {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  schemaVersion: number;
  createdAt: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-256-GCM';
  saltB64: string;
  ivB64: string;
  plaintextSha256: string;
  ciphertextB64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto در این محیط در دسترس نیست.');
  }
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a JSON accounting backup offline using PBKDF2-SHA-256 + AES-256-GCM
 * and embeds an authenticated SHA-256 plaintext checksum for post-decrypt verification.
 */
export async function encryptBackupEnvelope(
  snapshotJson: string,
  passphrase: string
): Promise<EncryptedBackupEnvelope> {
  const cleanPass = passphrase.trim();
  if (cleanPass.length < 6) {
    throw new Error('رمز عبور فایل پشتیبان رمزگذاری‌شده باید حداقل ۶ کاراکتر باشد.');
  }
  const parsedCheck = safeParseJsonObject(snapshotJson);
  if (!parsedCheck) {
    throw new Error('ساختار JSON پشتیبان معتبر نیست و امکان رمزگذاری وجود ندارد.');
  }

  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);

  const key = await deriveAesKeyFromPassphrase(cleanPass, salt, PBKDF2_ITERATIONS);
  const plaintextSha256 = await computeSnapshotSha256Hex(snapshotJson);
  const plaintextBytes = new TextEncoder().encode(snapshotJson);

  const ciphertextBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    plaintextBytes
  );

  return {
    format: ENCRYPTED_BACKUP_FORMAT,
    schemaVersion: ENCRYPTED_BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM',
    saltB64: bytesToBase64(salt),
    ivB64: bytesToBase64(iv),
    plaintextSha256,
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertextBuf)),
  };
}

export interface BackupVerificationResult {
  ok: boolean;
  snapshotJson?: string;
  sha256?: string;
  schemaVersion?: number;
  error?: string;
}

/**
 * Decrypts and verifies an offline AES-256-GCM backup envelope:
 * - Validates envelope format & schema version compatibility
 * - Decrypts with authenticated AES-GCM tag (rejects wrong password or tampered ciphertext)
 * - Recomputes SHA-256 over decrypted payload and verifies exact integrity match
 * - Parses JSON safely (prototype-pollution safe) before returning
 */
export async function decryptAndVerifyBackupEnvelope(
  rawEnvelopeJson: string,
  passphrase: string
): Promise<BackupVerificationResult> {
  const parsed = safeParseJsonObject(rawEnvelopeJson);
  if (!parsed) {
    return { ok: false, error: 'فایل پشتیبان خراب است یا فرمت JSON معتبر ندارد.' };
  }
  if (parsed.format !== ENCRYPTED_BACKUP_FORMAT) {
    return { ok: false, error: 'فرمت فایل پشتیبان رمزگذاری‌شده هلو Apex نیست.' };
  }
  const version = Number(parsed.schemaVersion);
  if (!Number.isInteger(version) || version < 1 || version > ENCRYPTED_BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `نسخه فایل پشتیبان (${String(parsed.schemaVersion)}) با این نسخه نرم‌افزار سازگار نیست.`,
    };
  }
  const iterations = Number(parsed.iterations);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) {
    return { ok: false, error: 'پارامترهای رمزنگاری فایل پشتیبان نامعتبر است.' };
  }
  if (
    parsed.kdf !== 'PBKDF2-SHA256' ||
    parsed.cipher !== 'AES-256-GCM' ||
    typeof parsed.saltB64 !== 'string' ||
    typeof parsed.ivB64 !== 'string' ||
    typeof parsed.ciphertextB64 !== 'string' ||
    typeof parsed.plaintextSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(parsed.plaintextSha256) ||
    parsed.saltB64.length > 64 ||
    parsed.ivB64.length > 32 ||
    parsed.ciphertextB64.length > 16_000_000
  ) {
    return { ok: false, error: 'فیلدهای امنیتی یا الگوریتم فایل پشتیبان نامعتبر است.' };
  }

  try {
    const salt = base64ToBytes(parsed.saltB64);
    const iv = base64ToBytes(parsed.ivB64);
    const ciphertext = base64ToBytes(parsed.ciphertextB64);
    // PBKDF2 salt must be 128 bits, AES-GCM nonce 96 bits, and the tag at least 128 bits.
    if (salt.byteLength !== 16 || iv.byteLength !== 12 || ciphertext.byteLength < 16) {
      return { ok: false, error: 'طول پارامترهای رمزنگاری فایل پشتیبان نامعتبر است.' };
    }
    const key = await deriveAesKeyFromPassphrase(passphrase.trim(), salt, iterations);
    const plainBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    const snapshotJson = new TextDecoder().decode(plainBuf);
    const actualSha256 = await computeSnapshotSha256Hex(snapshotJson);
    if (actualSha256 !== parsed.plaintextSha256) {
      return { ok: false, error: 'بررسی اصالت SHA-256 ناموفق بود؛ فایل پشتیبان دستکاری یا ناقص است.' };
    }
    const payloadObj = safeParseJsonObject(snapshotJson);
    if (!payloadObj) {
      return { ok: false, error: 'محتوای رمزگشایی‌شده ساختار معتبر حسابداری ندارد.' };
    }
    return { ok: true, snapshotJson, sha256: actualSha256, schemaVersion: version };
  } catch {
    return { ok: false, error: 'رمز عبور نادرست است یا فایل پشتیبان آسیب دیده است.' };
  }
}

export function hasBackupDigestBeenImported(sha256: string): boolean {
  try {
    const raw = localStorage.getItem(IMPORTED_BACKUP_DIGESTS_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.includes(sha256);
  } catch {
    return false;
  }
}

export function recordImportedBackupDigest(sha256: string): void {
  try {
    const raw = localStorage.getItem(IMPORTED_BACKUP_DIGESTS_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    const next = Array.from(new Set([sha256, ...(Array.isArray(list) ? list : [])])).slice(0, 50);
    localStorage.setItem(IMPORTED_BACKUP_DIGESTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

// ==================== 4. OFFLINE-SAFE LOCAL AUTH & WORKSPACE ISOLATION ====================

export interface LocalOfflineCredentialRecord {
  workspaceId: string;
  deviceId: string;
  authScope: 'local_only';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  saltB64: string;
  hashHex: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Creates a salted PBKDF2-SHA-256 local offline unlock record.
 * NEVER stores plaintext passcodes and explicitly marks `authScope: 'local_only'`
 * so offline local unlock can never be confused with cloud API authorization.
 */
export async function createLocalOfflinePasscodeRecord(params: {
  workspaceId: string;
  deviceId: string;
  passcode: string;
  sessionTtlHours?: number;
}): Promise<LocalOfflineCredentialRecord> {
  const cleanPass = params.passcode.trim();
  if (cleanPass.length < 4) {
    throw new Error('رمز ورود آفلاین باید حداقل ۴ کاراکتر باشد.');
  }
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const subtle = globalThis.crypto.subtle;
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(cleanPass),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  const now = Date.now();
  const ttlMs = Math.max(1, params.sessionTtlHours ?? 24 * 14) * 3600 * 1000;
  return {
    workspaceId: params.workspaceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'local_default',
    deviceId: params.deviceId.slice(0, 64),
    authScope: 'local_only',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    saltB64: bytesToBase64(salt),
    hashHex,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
}

export async function verifyLocalOfflinePasscode(
  record: LocalOfflineCredentialRecord,
  candidatePasscode: string,
  nowMs = Date.now()
): Promise<{ valid: boolean; expired: boolean }> {
  const expMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expMs) || nowMs > expMs) {
    return { valid: false, expired: true };
  }
  const salt = base64ToBytes(record.saltB64);
  const subtle = globalThis.crypto.subtle;
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(candidatePasscode.trim()),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: record.iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const actualHex = Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
  let diff = actualHex.length ^ record.hashHex.length;
  for (let i = 0; i < Math.max(actualHex.length, record.hashHex.length); i++) {
    diff |= (actualHex.charCodeAt(i) || 0) ^ (record.hashHex.charCodeAt(i) || 0);
  }
  return { valid: diff === 0, expired: false };
}

/** Builds an isolated storage namespace key so multiple users on one shared device never leak records */
export function buildIsolatedWorkspaceStorageKey(workspaceId: string, suffix: string): string {
  const safeWs = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `holoo_ws_${safeWs}__${safeSuffix}`;
}

// ==================== 5. EXPONENTIAL BACKOFF & STORAGE QUOTA GUARD ====================

export function computeSyncBackoffMs(
  retryCount: number,
  baseMs = 2000,
  maxMs = 5 * 60 * 1000,
  jitterFactor = 0
): number {
  const safeRetries = Math.max(0, Math.min(20, Math.trunc(retryCount)));
  const exp = Math.min(maxMs, baseMs * Math.pow(2, safeRetries));
  const jitter = Math.round(exp * Math.max(0, Math.min(0.3, jitterFactor)));
  return Math.min(maxMs, exp + jitter);
}

export const STORAGE_WARNING_RATIO = 0.8;
export const STORAGE_CRITICAL_RATIO = 0.92;
export const STORAGE_MIN_FREE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface DeviceStorageHealth {
  supported: boolean;
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
  freeBytes: number;
  usageRatio: number;
  status: 'ok' | 'warning' | 'critical';
  warningMessage: string | null;
}

export function evaluateStorageHealthSnapshot(
  usageBytes: number,
  quotaBytes: number,
  persisted: boolean
): DeviceStorageHealth {
  const safeUsage = Math.max(0, Number(usageBytes) || 0);
  const safeQuota = Math.max(0, Number(quotaBytes) || 0);
  const freeBytes = Math.max(0, safeQuota - safeUsage);
  const usageRatio = safeQuota > 0 ? safeUsage / safeQuota : 0;

  if (safeQuota > 0 && (usageRatio >= STORAGE_CRITICAL_RATIO || freeBytes < STORAGE_MIN_FREE_BYTES)) {
    return {
      supported: true,
      persisted,
      usageBytes: safeUsage,
      quotaBytes: safeQuota,
      freeBytes,
      usageRatio,
      status: 'critical',
      warningMessage:
        'فضای ذخیره‌سازی محلی دستگاه تقریباً پر شده است! پیش از ثبت سند جدید، پشتیبان رمزگذاری‌شده تهیه کنید و کش‌های قدیمی را پاکسازی نمایید.',
    };
  }
  if (safeQuota > 0 && usageRatio >= STORAGE_WARNING_RATIO) {
    return {
      supported: true,
      persisted,
      usageBytes: safeUsage,
      quotaBytes: safeQuota,
      freeBytes,
      usageRatio,
      status: 'warning',
      warningMessage:
        'بیش از ۸۰٪ فضای ذخیره‌سازی محلی دستگاه مصرف شده است؛ توصیه می‌شود پشتیبان محلی ذخیره کنید.',
    };
  }
  return {
    supported: true,
    persisted,
    usageBytes: safeUsage,
    quotaBytes: safeQuota,
    freeBytes,
    usageRatio,
    status: 'ok',
    warningMessage: null,
  };
}

export async function inspectDeviceStorageHealth(): Promise<DeviceStorageHealth> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      supported: false,
      persisted: false,
      usageBytes: 0,
      quotaBytes: 0,
      freeBytes: 0,
      usageRatio: 0,
      status: 'ok',
      warningMessage: null,
    };
  }
  try {
    const [est, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
    ]);
    return evaluateStorageHealthSnapshot(est.usage ?? 0, est.quota ?? 0, persisted);
  } catch {
    return {
      supported: true,
      persisted: false,
      usageBytes: 0,
      quotaBytes: 0,
      freeBytes: 0,
      usageRatio: 0,
      status: 'ok',
      warningMessage: null,
    };
  }
}

// ==================== 6. FINANCIAL CONFLICT HUMAN-REVIEW GUARD ====================

export type FinancialCollectionKind = 'vouchers' | 'invoices' | 'products' | 'cheques' | 'parties' | 'settings';

/**
 * Enforces strict accounting governance:
 * Permanent vouchers, issued/settled invoices, and FIFO-bearing inventory mutations
 * must NEVER be silently overwritten by automated Last-Write-Wins when a true conflict exists.
 */
export function requiresManualFinancialConflictReview(
  collection: FinancialCollectionKind,
  localRecord: Record<string, unknown>,
  remoteRecord: Record<string, unknown>
): boolean {
  if (collection === 'vouchers') {
    // Permanent vouchers are legally immutable; any divergence requires human review
    if (localRecord.status === 'permanent' || remoteRecord.status === 'permanent') {
      return true;
    }
    return Number(localRecord.totalDebit) !== Number(remoteRecord.totalDebit);
  }
  if (collection === 'invoices') {
    return (
      localRecord.invoiceType !== 'proforma' ||
      remoteRecord.invoiceType !== 'proforma' ||
      Number(localRecord.grandTotal) !== Number(remoteRecord.grandTotal)
    );
  }
  if (collection === 'products') {
    return (
      Number(localRecord.stock) !== Number(remoteRecord.stock) ||
      Number(localRecord.inventoryValueIrr) !== Number(remoteRecord.inventoryValueIrr)
    );
  }
  if (collection === 'cheques') {
    return localRecord.status !== remoteRecord.status || Number(localRecord.amount) !== Number(remoteRecord.amount);
  }
  return false;
}
