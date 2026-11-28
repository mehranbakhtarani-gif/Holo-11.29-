/**
 * Versioned key envelope for the operational workspace data-encryption key.
 *
 * A random DEK encrypts operational records. The user's passphrase derives only
 * a KEK that wraps the DEK, so passphrase changes can re-wrap one small key
 * without re-encrypting every financial record.
 */
import {
  createOperationalDataSalt,
  deriveOperationalDataKey,
  OPERATIONAL_RECORD_KDF_ITERATIONS,
} from './operationalRecordEncryption';

export const OPERATIONAL_KEY_DESCRIPTOR_FORMAT = 'holoo-apex-operational-key';
export const OPERATIONAL_KEY_DESCRIPTOR_VERSION = 2;
export const OPERATIONAL_KEY_DESCRIPTOR_CIPHER = 'AES-256-GCM';
export const OPERATIONAL_KEY_DESCRIPTOR_KDF = 'PBKDF2-SHA-256';

const DATA_KEY_BYTES = 32;
const WRAP_IV_BYTES = 12;
const WRAPPED_KEY_BYTES = DATA_KEY_BYTES + 16;

export interface OperationalKeyDescriptor {
  format: typeof OPERATIONAL_KEY_DESCRIPTOR_FORMAT;
  version: typeof OPERATIONAL_KEY_DESCRIPTOR_VERSION;
  workspaceId: string;
  keyId: string;
  cipher: typeof OPERATIONAL_KEY_DESCRIPTOR_CIPHER;
  kdf: typeof OPERATIONAL_KEY_DESCRIPTOR_KDF;
  iterations: number;
  saltB64: string;
  wrapIvB64: string;
  wrappedKeyB64: string;
  createdAt: string;
}

type DescriptorIdentity = Pick<
  OperationalKeyDescriptor,
  'format' | 'version' | 'workspaceId' | 'keyId' | 'cipher' | 'kdf' | 'iterations' | 'saltB64' | 'createdAt'
>;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, expectedBytes: number, label: string): Uint8Array {
  const expectedEncodedLength = Math.ceil(expectedBytes / 3) * 4;
  if (value.length !== expectedEncodedLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Operational key descriptor ${label} encoding is invalid.`);
  }
  const decoded = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (decoded.byteLength !== expectedBytes || encodeBase64(decoded) !== value) {
    throw new Error(`Operational key descriptor ${label} must be canonical base64 for ${expectedBytes} bytes.`);
  }
  return decoded;
}

function decodeSalt(value: string): Uint8Array {
  return decodeBase64(value, 16, 'salt');
}

function descriptorAad(identity: DescriptorIdentity): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    identity.format,
    identity.version,
    identity.workspaceId,
    identity.keyId,
    identity.cipher,
    identity.kdf,
    identity.iterations,
    identity.saltB64,
    identity.createdAt,
  ]));
}

function requireRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Web Crypto randomness is required for operational key wrapping.');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function isDescriptorIdentity(value: unknown): value is DescriptorIdentity {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<DescriptorIdentity>;
  try {
    if (typeof row.saltB64 !== 'string') return false;
    decodeSalt(row.saltB64);
  } catch {
    return false;
  }
  return row.format === OPERATIONAL_KEY_DESCRIPTOR_FORMAT &&
    row.version === OPERATIONAL_KEY_DESCRIPTOR_VERSION &&
    typeof row.workspaceId === 'string' && row.workspaceId.trim().length > 0 && row.workspaceId.length <= 180 &&
    typeof row.keyId === 'string' && /^[a-zA-Z0-9_-]{12,80}$/.test(row.keyId) &&
    row.cipher === OPERATIONAL_KEY_DESCRIPTOR_CIPHER &&
    row.kdf === OPERATIONAL_KEY_DESCRIPTOR_KDF &&
    Number.isSafeInteger(row.iterations) &&
    Number(row.iterations) >= OPERATIONAL_RECORD_KDF_ITERATIONS &&
    Number(row.iterations) <= 1_000_000 &&
    typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt));
}

export function isOperationalKeyDescriptor(value: unknown): value is OperationalKeyDescriptor {
  if (!isDescriptorIdentity(value)) return false;
  const row = value as Partial<OperationalKeyDescriptor>;
  try {
    if (typeof row.wrapIvB64 !== 'string' || typeof row.wrappedKeyB64 !== 'string') return false;
    decodeBase64(row.wrapIvB64, WRAP_IV_BYTES, 'wrapping IV');
    decodeBase64(row.wrappedKeyB64, WRAPPED_KEY_BYTES, 'wrapped data key');
    return true;
  } catch {
    return false;
  }
}

function createDescriptorIdentity(
  workspaceId: string,
  keyId: string,
  salt: Uint8Array,
  createdAt: string
): DescriptorIdentity {
  const identity: DescriptorIdentity = {
    format: OPERATIONAL_KEY_DESCRIPTOR_FORMAT,
    version: OPERATIONAL_KEY_DESCRIPTOR_VERSION,
    workspaceId,
    keyId,
    cipher: OPERATIONAL_KEY_DESCRIPTOR_CIPHER,
    kdf: OPERATIONAL_KEY_DESCRIPTOR_KDF,
    iterations: OPERATIONAL_RECORD_KDF_ITERATIONS,
    saltB64: encodeBase64(salt),
    createdAt,
  };
  if (!isDescriptorIdentity(identity)) {
    throw new Error('Operational key descriptor identity is invalid.');
  }
  return identity;
}

function validateCreationInputs(workspaceId: string, keyId: string, createdAt: string): void {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 180) {
    throw new Error('Operational key descriptor workspace identity is invalid.');
  }
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(keyId)) {
    throw new Error('Operational key descriptor ID is invalid.');
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Operational key descriptor creation time is invalid.');
  }
}

async function wrapRawDataKey(
  rawDataKey: Uint8Array,
  passphrase: string,
  identity: DescriptorIdentity
): Promise<OperationalKeyDescriptor> {
  if (rawDataKey.byteLength !== DATA_KEY_BYTES) {
    throw new Error('Operational data key must be exactly 256 bits.');
  }
  const kek = await deriveOperationalDataKey(
    passphrase,
    decodeSalt(identity.saltB64),
    identity.iterations
  );
  const iv = requireRandomBytes(WRAP_IV_BYTES);
  const rawBuffer = toArrayBuffer(rawDataKey);
  let wrapped: ArrayBuffer;
  try {
    wrapped = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(descriptorAad(identity)), tagLength: 128 },
      kek,
      rawBuffer
    );
  } finally {
    // Clear the temporary copy as well as the caller-owned raw key buffer.
    new Uint8Array(rawBuffer).fill(0);
  }
  const descriptor: OperationalKeyDescriptor = {
    ...identity,
    wrapIvB64: encodeBase64(iv),
    wrappedKeyB64: encodeBase64(new Uint8Array(wrapped)),
  };
  if (!isOperationalKeyDescriptor(descriptor)) {
    throw new Error('Operational key descriptor failed envelope validation.');
  }
  return descriptor;
}

async function unwrapRawDataKey(
  passphrase: string,
  descriptor: OperationalKeyDescriptor
): Promise<Uint8Array> {
  const kek = await deriveOperationalDataKey(
    passphrase,
    decodeSalt(descriptor.saltB64),
    descriptor.iterations
  );
  const raw = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(decodeBase64(descriptor.wrapIvB64, WRAP_IV_BYTES, 'wrapping IV')),
      additionalData: toArrayBuffer(descriptorAad(descriptor)),
      tagLength: 128,
    },
    kek,
    toArrayBuffer(decodeBase64(descriptor.wrappedKeyB64, WRAPPED_KEY_BYTES, 'wrapped data key'))
  );
  const bytes = new Uint8Array(raw);
  if (bytes.byteLength !== DATA_KEY_BYTES) {
    bytes.fill(0);
    throw new Error('Unwrapped operational data key has an invalid length.');
  }
  return bytes;
}

/** Generate a random DEK and persist only its authenticated, passphrase-wrapped envelope. */
export async function createOperationalKeyDescriptor(
  workspaceId: string,
  keyId: string,
  passphrase: string,
  createdAt = new Date().toISOString()
): Promise<OperationalKeyDescriptor> {
  validateCreationInputs(workspaceId, keyId, createdAt);
  const identity = createDescriptorIdentity(
    workspaceId,
    keyId,
    createOperationalDataSalt(),
    createdAt
  );
  const raw = requireRandomBytes(DATA_KEY_BYTES);
  try {
    return await wrapRawDataKey(raw, passphrase, identity);
  } finally {
    raw.fill(0);
  }
}

/** Unwrap the workspace DEK and immediately import it as a non-extractable CryptoKey. */
export async function deriveOperationalKeyFromDescriptor(
  passphrase: string,
  descriptor: OperationalKeyDescriptor,
  expectedWorkspaceId: string
): Promise<CryptoKey> {
  if (!isOperationalKeyDescriptor(descriptor) || descriptor.workspaceId !== expectedWorkspaceId) {
    throw new Error('Operational key descriptor is invalid or belongs to another workspace.');
  }
  const raw = await unwrapRawDataKey(passphrase, descriptor);
  const rawBuffer = toArrayBuffer(raw);
  try {
    return await globalThis.crypto.subtle.importKey(
      'raw',
      rawBuffer,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  } finally {
    raw.fill(0);
    new Uint8Array(rawBuffer).fill(0);
  }
}

/**
 * Change the wrapping passphrase without changing the DEK. Existing encrypted
 * records therefore remain readable and do not need a bulk re-encryption.
 */
export async function rewrapOperationalKeyDescriptor(
  descriptor: OperationalKeyDescriptor,
  currentPassphrase: string,
  nextPassphrase: string,
  createdAt = new Date().toISOString()
): Promise<OperationalKeyDescriptor> {
  if (!isOperationalKeyDescriptor(descriptor)) {
    throw new Error('Operational key descriptor is invalid.');
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Operational key descriptor creation time is invalid.');
  }
  const raw = await unwrapRawDataKey(currentPassphrase, descriptor);
  try {
    const identity = createDescriptorIdentity(
      descriptor.workspaceId,
      descriptor.keyId,
      createOperationalDataSalt(),
      createdAt
    );
    return await wrapRawDataKey(raw, nextPassphrase, identity);
  } finally {
    raw.fill(0);
  }
}
