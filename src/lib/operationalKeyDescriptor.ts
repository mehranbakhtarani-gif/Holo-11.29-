/**
 * Versioned metadata for deriving the operational workspace data-encryption key.
 *
 * This descriptor is safe to persist: it contains KDF parameters and a random salt,
 * never a passphrase or CryptoKey. It is groundwork for the coordinated DB cutover.
 */
import {
  createOperationalDataSalt,
  deriveOperationalDataKey,
  OPERATIONAL_RECORD_KDF_ITERATIONS,
} from './operationalRecordEncryption';

export const OPERATIONAL_KEY_DESCRIPTOR_FORMAT = 'holoo-apex-operational-key';
export const OPERATIONAL_KEY_DESCRIPTOR_VERSION = 1;
export const OPERATIONAL_KEY_DESCRIPTOR_CIPHER = 'AES-256-GCM';
export const OPERATIONAL_KEY_DESCRIPTOR_KDF = 'PBKDF2-SHA-256';

export interface OperationalKeyDescriptor {
  format: typeof OPERATIONAL_KEY_DESCRIPTOR_FORMAT;
  version: typeof OPERATIONAL_KEY_DESCRIPTOR_VERSION;
  workspaceId: string;
  keyId: string;
  cipher: typeof OPERATIONAL_KEY_DESCRIPTOR_CIPHER;
  kdf: typeof OPERATIONAL_KEY_DESCRIPTOR_KDF;
  iterations: number;
  saltB64: string;
  createdAt: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeSalt(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw new Error('Operational key descriptor salt encoding is invalid.');
  }
  const decoded = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (decoded.byteLength !== 16 || encodeBase64(decoded) !== value) {
    throw new Error('Operational key descriptor salt must be canonical base64 for 16 bytes.');
  }
  return decoded;
}

export function isOperationalKeyDescriptor(value: unknown): value is OperationalKeyDescriptor {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<OperationalKeyDescriptor>;
  let saltIsValid = false;
  if (typeof row.saltB64 === 'string') {
    try {
      decodeSalt(row.saltB64);
      saltIsValid = true;
    } catch {
      saltIsValid = false;
    }
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
    saltIsValid &&
    typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt));
}

/** Create fresh, workspace-bound KDF metadata. Persist this descriptor, not the secret. */
export function createOperationalKeyDescriptor(
  workspaceId: string,
  keyId: string,
  createdAt = new Date().toISOString()
): OperationalKeyDescriptor {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 180) {
    throw new Error('Operational key descriptor workspace identity is invalid.');
  }
  if (typeof keyId !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(keyId)) {
    throw new Error('Operational key descriptor ID is invalid.');
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('Operational key descriptor creation time is invalid.');
  }
  const descriptor: OperationalKeyDescriptor = {
    format: OPERATIONAL_KEY_DESCRIPTOR_FORMAT,
    version: OPERATIONAL_KEY_DESCRIPTOR_VERSION,
    workspaceId,
    keyId,
    cipher: OPERATIONAL_KEY_DESCRIPTOR_CIPHER,
    kdf: OPERATIONAL_KEY_DESCRIPTOR_KDF,
    iterations: OPERATIONAL_RECORD_KDF_ITERATIONS,
    saltB64: encodeBase64(createOperationalDataSalt()),
    createdAt,
  };
  if (!isOperationalKeyDescriptor(descriptor)) {
    throw new Error('Operational key descriptor creation failed validation.');
  }
  return descriptor;
}

/** Validate descriptor identity before deriving a non-extractable workspace key. */
export async function deriveOperationalKeyFromDescriptor(
  passphrase: string,
  descriptor: OperationalKeyDescriptor,
  expectedWorkspaceId: string
): Promise<CryptoKey> {
  if (!isOperationalKeyDescriptor(descriptor) || descriptor.workspaceId !== expectedWorkspaceId) {
    throw new Error('Operational key descriptor is invalid or belongs to another workspace.');
  }
  return deriveOperationalDataKey(
    passphrase,
    decodeSalt(descriptor.saltB64),
    descriptor.iterations
  );
}
