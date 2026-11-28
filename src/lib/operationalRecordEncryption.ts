/**
 * Authenticated per-record encryption primitives for the operational IndexedDB cutover.
 *
 * This module is deliberately not wired into operationalDb yet. The production cutover
 * must replace every reader, writer, index-dependent query, and multi-store transaction
 * as one coordinated migration; using this codec in only part of the data path would
 * create mixed plaintext/ciphertext records and risk data loss.
 */
export const OPERATIONAL_RECORD_ENVELOPE_FORMAT = 'holoo-apex-operational-record';
export const OPERATIONAL_RECORD_ENVELOPE_VERSION = 1;
export const OPERATIONAL_RECORD_KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 32_000_000;

export type OperationalEncryptedStore =
  | 'accounts' | 'parties' | 'products' | 'vouchers' | 'invoices' | 'cheques'
  | 'employees' | 'assets' | 'costCenters' | 'currencies' | 'exchangeRates'
  | 'importDossiers' | 'salesOrders' | 'subcontractJobs' | 'rbacOperators'
  | 'auditLogs' | 'warehouses' | 'taxReports' | 'localProfiles';

export interface OperationalRecordContext {
  workspaceId: string;
  store: OperationalEncryptedStore;
  recordId: string;
}

export interface OperationalRecordEnvelope extends OperationalRecordContext {
  format: typeof OPERATIONAL_RECORD_ENVELOPE_FORMAT;
  version: typeof OPERATIONAL_RECORD_ENVELOPE_VERSION;
  cipher: 'AES-256-GCM';
  ivB64: string;
  ciphertextB64: string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requireWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto is required for operational data encryption.');
  }
  return globalThis.crypto;
}

function assertContext(context: OperationalRecordContext): void {
  if (
    !context || typeof context.workspaceId !== 'string' || !context.workspaceId.trim() ||
    typeof context.recordId !== 'string' || !context.recordId.trim() ||
    typeof context.store !== 'string'
  ) throw new Error('Operational record encryption context is invalid.');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Operational encrypted record has invalid base64 data.');
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function additionalData(context: OperationalRecordContext): Uint8Array {
  // Stable canonical AAD binds ciphertext to its workspace, object store, and primary key.
  return new TextEncoder().encode(JSON.stringify([
    OPERATIONAL_RECORD_ENVELOPE_FORMAT,
    OPERATIONAL_RECORD_ENVELOPE_VERSION,
    context.workspaceId,
    context.store,
    context.recordId,
  ]));
}

/** Derive a non-extractable AES-256-GCM key. Persist the random salt, never the passphrase. */
export async function deriveOperationalDataKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = OPERATIONAL_RECORD_KDF_ITERATIONS
): Promise<CryptoKey> {
  const cryptoApi = requireWebCrypto();
  if (typeof passphrase !== 'string' || passphrase.trim().length < 10) {
    throw new Error('Operational encryption passphrase must contain at least 10 characters.');
  }
  if (!(salt instanceof Uint8Array) || salt.byteLength !== SALT_BYTES) {
    throw new Error('Operational encryption salt must be exactly 16 bytes.');
  }
  if (!Number.isInteger(iterations) || iterations < 600_000 || iterations > 1_000_000) {
    throw new Error('Operational encryption KDF work factor is outside the accepted range.');
  }
  const material = await cryptoApi.subtle.importKey(
    'raw', toArrayBuffer(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveKey']
  );
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function createOperationalDataSalt(): Uint8Array {
  return requireWebCrypto().getRandomValues(new Uint8Array(SALT_BYTES));
}

/** Encrypt one JSON-compatible record with AES-GCM and context-bound authenticated data. */
export async function encryptOperationalRecord<T>(
  value: T,
  context: OperationalRecordContext,
  key: CryptoKey
): Promise<OperationalRecordEnvelope> {
  assertContext(context);
  if (!key || key.type !== 'secret' || !key.usages.includes('encrypt')) {
    throw new Error('A valid operational AES encryption key is required.');
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const iv = requireWebCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await requireWebCrypto().subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData(context)), tagLength: 128 },
    key,
    toArrayBuffer(plaintext)
  );
  return {
    format: OPERATIONAL_RECORD_ENVELOPE_FORMAT,
    version: OPERATIONAL_RECORD_ENVELOPE_VERSION,
    ...context,
    cipher: 'AES-256-GCM',
    ivB64: toBase64(iv),
    ciphertextB64: toBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypt only when envelope identity exactly matches the requested IndexedDB location. */
export async function decryptOperationalRecord<T>(
  envelope: OperationalRecordEnvelope,
  expectedContext: OperationalRecordContext,
  key: CryptoKey
): Promise<T> {
  assertContext(expectedContext);
  if (
    !envelope || envelope.format !== OPERATIONAL_RECORD_ENVELOPE_FORMAT ||
    envelope.version !== OPERATIONAL_RECORD_ENVELOPE_VERSION ||
    envelope.cipher !== 'AES-256-GCM' ||
    envelope.workspaceId !== expectedContext.workspaceId ||
    envelope.store !== expectedContext.store ||
    envelope.recordId !== expectedContext.recordId ||
    typeof envelope.ivB64 !== 'string' || typeof envelope.ciphertextB64 !== 'string' ||
    envelope.ciphertextB64.length > MAX_ENVELOPE_BYTES
  ) throw new Error('Operational encrypted record metadata or identity is invalid.');
  if (!key || key.type !== 'secret' || !key.usages.includes('decrypt')) {
    throw new Error('A valid operational AES decryption key is required.');
  }
  const iv = fromBase64(envelope.ivB64);
  const ciphertext = fromBase64(envelope.ciphertextB64);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < GCM_TAG_BYTES) {
    throw new Error('Operational encrypted record has invalid IV or authentication tag length.');
  }
  const plaintext = await requireWebCrypto().subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData(expectedContext)), tagLength: 128 },
    key,
    toArrayBuffer(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
