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
const ENCRYPTED_STORES = new Set<OperationalEncryptedStore>([
  'accounts', 'parties', 'products', 'vouchers', 'invoices', 'cheques',
  'employees', 'assets', 'costCenters', 'currencies', 'exchangeRates',
  'importDossiers', 'salesOrders', 'subcontractJobs', 'rbacOperators',
  'auditLogs', 'warehouses', 'taxReports', 'localProfiles',
]);

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
    typeof context.store !== 'string' ||
    !ENCRYPTED_STORES.has(context.store as OperationalEncryptedStore)
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
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (toBase64(decoded) !== value) {
    decoded.fill(0);
    throw new Error('Operational encrypted record has non-canonical base64 data.');
  }
  return decoded;
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
  // Web Crypto copies imported key material, but the caller-owned byte buffers remain
  // in JavaScript memory unless explicitly cleared after importKey resolves.
  const passphraseBytes = new TextEncoder().encode(passphrase);
  const passphraseBuffer = toArrayBuffer(passphraseBytes);
  let material: CryptoKey;
  try {
    material = await cryptoApi.subtle.importKey(
      'raw', passphraseBuffer, 'PBKDF2', false, ['deriveKey']
    );
  } finally {
    passphraseBytes.fill(0);
    new Uint8Array(passphraseBuffer).fill(0);
  }
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
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new Error('Operational records must serialize to a JSON value.');
  }
  let serialized = json;
  const plaintext = new TextEncoder().encode(serialized);
  if (plaintext.byteLength + GCM_TAG_BYTES > MAX_ENVELOPE_BYTES) {
    plaintext.fill(0);
    throw new Error('Operational record exceeds the maximum encrypted record size.');
  }
  const plaintextBuffer = toArrayBuffer(plaintext);
  const iv = requireWebCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const aad = additionalData(context);
  const ivBuffer = toArrayBuffer(iv);
  const aadBuffer = toArrayBuffer(aad);
  let ciphertext: ArrayBuffer | null = null;
  try {
    ciphertext = await requireWebCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv: ivBuffer, additionalData: aadBuffer, tagLength: 128 },
      key,
      plaintextBuffer
    );
    return {
      format: OPERATIONAL_RECORD_ENVELOPE_FORMAT,
      version: OPERATIONAL_RECORD_ENVELOPE_VERSION,
      ...context,
      cipher: 'AES-256-GCM',
      ivB64: toBase64(iv),
      ciphertextB64: toBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    // Clear plaintext, nonce, AAD, and all copies passed to Web Crypto on every path.
    plaintext.fill(0);
    new Uint8Array(plaintextBuffer).fill(0);
    iv.fill(0);
    aad.fill(0);
    new Uint8Array(ivBuffer).fill(0);
    new Uint8Array(aadBuffer).fill(0);
    if (ciphertext) new Uint8Array(ciphertext).fill(0);
    serialized = '';
  }
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
    typeof envelope.ivB64 !== 'string' || envelope.ivB64.length !== 16 ||
    typeof envelope.ciphertextB64 !== 'string' || envelope.ciphertextB64.length > MAX_ENVELOPE_BYTES
  ) throw new Error('Operational encrypted record metadata or identity is invalid.');
  if (!key || key.type !== 'secret' || !key.usages.includes('decrypt')) {
    throw new Error('A valid operational AES decryption key is required.');
  }
  const iv = fromBase64(envelope.ivB64);
  const ciphertext = fromBase64(envelope.ciphertextB64);
  if (iv.byteLength !== IV_BYTES || ciphertext.byteLength < GCM_TAG_BYTES) {
    throw new Error('Operational encrypted record has invalid IV or authentication tag length.');
  }
  const ivBuffer = toArrayBuffer(iv);
  const ciphertextBuffer = toArrayBuffer(ciphertext);
  const aad = additionalData(expectedContext);
  const aadBuffer = toArrayBuffer(aad);
  try {
    const plaintext = await requireWebCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: ivBuffer, additionalData: aadBuffer, tagLength: 128 },
      key,
      ciphertextBuffer
    );
    let serialized: string | undefined;
    try {
      serialized = new TextDecoder().decode(plaintext);
      return JSON.parse(serialized) as T;
    } finally {
      // Do not leave decrypted record bytes resident after parsing or a parse failure.
      new Uint8Array(plaintext).fill(0);
      serialized = undefined;
    }
  } finally {
    // Clear decoded and copied encrypted buffers even when authentication or parsing fails.
    iv.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
    new Uint8Array(ivBuffer).fill(0);
    new Uint8Array(ciphertextBuffer).fill(0);
    new Uint8Array(aadBuffer).fill(0);
  }
}
