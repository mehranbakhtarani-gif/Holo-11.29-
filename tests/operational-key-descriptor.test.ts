import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createOperationalKeyDescriptor,
  deriveOperationalKeyFromDescriptor,
  isOperationalKeyDescriptor,
  OPERATIONAL_KEY_DESCRIPTOR_VERSION,
  rewrapOperationalKeyDescriptor,
} from '../src/lib/operationalKeyDescriptor';
import {
  decryptOperationalRecord,
  encryptOperationalRecord,
} from '../src/lib/operationalRecordEncryption';

async function run() {
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const previousRandom = Object.getOwnPropertyDescriptor(webcrypto, 'getRandomValues');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    const subtle = webcrypto.subtle;
    const originalRandom = webcrypto.getRandomValues.bind(webcrypto);
    const randomBuffers: Uint8Array[] = [];
    Object.defineProperty(webcrypto, 'getRandomValues', {
      configurable: true,
      value: ((array: Uint8Array) => {
        randomBuffers.push(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        return originalRandom(array);
      }) as typeof webcrypto.getRandomValues,
    });
    const originalEncrypt = subtle.encrypt.bind(subtle);
    const encryptionBuffers: Uint8Array[] = [];
    Object.defineProperty(subtle, 'encrypt', {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams, key: CryptoKey, data: BufferSource) => {
        if (typeof algorithm === 'object' && 'name' in algorithm && algorithm.name === 'AES-GCM') {
          const params = algorithm as AesGcmParams;
          if (params.iv instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(params.iv));
          if (params.additionalData instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(params.additionalData));
          if (data instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(data));
        }
        return originalEncrypt(algorithm, key, data);
      },
    });
    const oldPassphrase = 'OperationalEncryption#1405';
    const newPassphrase = 'OperationalEncryption#1406';
    const descriptor = await createOperationalKeyDescriptor(
      'workspace-finance-01',
      'operational-key-1405',
      oldPassphrase
    );
    assert.equal(randomBuffers.length, 3, 'descriptor creation must allocate only salt, DEK, and wrapping IV random buffers');
    assert.ok(
      randomBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      'descriptor creation must clear generated salt, raw DEK, and wrapping IV buffers'
    );
    randomBuffers.length = 0;
    assert.ok(encryptionBuffers.length >= 3, 'DEK wrapping must pass only owned buffers to Web Crypto');
    assert.ok(
      encryptionBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      'DEK wrapping IV, AAD, and raw-key copies must be zeroed after encryption'
    );
    Object.defineProperty(subtle, 'encrypt', {
      configurable: true,
      value: originalEncrypt,
    });
    assert.equal(descriptor.version, OPERATIONAL_KEY_DESCRIPTOR_VERSION);
    assert.equal(descriptor.version, 2);
    assert.equal(descriptor.workspaceId, 'workspace-finance-01');
    assert.equal(descriptor.cipher, 'AES-256-GCM');
    assert.equal(descriptor.kdf, 'PBKDF2-SHA-256');
    assert.equal(descriptor.iterations, 600_000);
    assert.equal(atob(descriptor.saltB64).length, 16);
    assert.equal(atob(descriptor.wrapIvB64).length, 12);
    assert.equal(atob(descriptor.wrappedKeyB64).length, 48);
    assert.equal(isOperationalKeyDescriptor(descriptor), true);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, version: 99 }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, iterations: 100_000 }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, workspaceId: '' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, keyId: 'bad' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, cipher: 'AES-CBC' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, saltB64: 'not-base64' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, saltB64: 'A'.repeat(1_000_000) }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, saltB64: 'AAAAAAAAAAAAAAAAAAAAA===' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, createdAt: 'invalid' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, wrapIvB64: 'AA==' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, wrappedKeyB64: 'AA==' }), false);

    const restored = JSON.parse(JSON.stringify(descriptor));
    assert.equal(isOperationalKeyDescriptor(restored), true);
    const originalDecrypt = subtle.decrypt.bind(subtle);
    const decryptionBuffers: Uint8Array[] = [];
    Object.defineProperty(subtle, 'decrypt', {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams, key: CryptoKey, data: BufferSource) => {
        if (typeof algorithm === 'object' && 'name' in algorithm && algorithm.name === 'AES-GCM') {
          const params = algorithm as AesGcmParams;
          if (params.iv instanceof ArrayBuffer) decryptionBuffers.push(new Uint8Array(params.iv));
          if (params.additionalData instanceof ArrayBuffer) decryptionBuffers.push(new Uint8Array(params.additionalData));
          if (data instanceof ArrayBuffer) decryptionBuffers.push(new Uint8Array(data));
        }
        return originalDecrypt(algorithm, key, data);
      },
    });
    const key = await deriveOperationalKeyFromDescriptor(
      oldPassphrase,
      restored,
      'workspace-finance-01'
    );
    assert.ok(decryptionBuffers.length >= 3, 'DEK unwrapping must use owned buffers');
    assert.ok(
      decryptionBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      'DEK unwrapping IV, AAD, and wrapped-key copies must be zeroed after decryption'
    );
    Object.defineProperty(subtle, 'decrypt', {
      configurable: true,
      value: originalDecrypt,
    });
    assert.equal(key.type, 'secret');
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ['encrypt', 'decrypt']);

    const context = {
      workspaceId: 'workspace-finance-01',
      store: 'vouchers' as const,
      recordId: 'voucher-0001',
    };
    const encrypted = await encryptOperationalRecord(
      { voucherNumber: 1, debit: 2500, credit: 2500 },
      context,
      key
    );
    assert.deepEqual(
      await decryptOperationalRecord(encrypted, context, key),
      { voucherNumber: 1, debit: 2500, credit: 2500 }
    );

    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor(oldPassphrase, restored, 'workspace-other'),
      /invalid or belongs to another workspace/
    );
    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor('short', restored, 'workspace-finance-01'),
      /at least 10/
    );
    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor(newPassphrase, restored, 'workspace-finance-01')
    );

    const rewrapped = await rewrapOperationalKeyDescriptor(
      restored,
      oldPassphrase,
      newPassphrase
    );
    assert.equal(randomBuffers.length, 2, 'descriptor rewrap must allocate only a fresh salt and wrapping IV');
    assert.ok(
      randomBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      'descriptor rewrap must clear generated salt and wrapping IV buffers'
    );
    randomBuffers.length = 0;
    assert.equal(rewrapped.workspaceId, restored.workspaceId);
    assert.equal(rewrapped.keyId, restored.keyId);
    assert.notEqual(rewrapped.saltB64, restored.saltB64);
    assert.notEqual(rewrapped.wrapIvB64, restored.wrapIvB64);
    assert.notEqual(rewrapped.wrappedKeyB64, restored.wrappedKeyB64);
    const newKey = await deriveOperationalKeyFromDescriptor(
      newPassphrase,
      rewrapped,
      'workspace-finance-01'
    );
    assert.deepEqual(await decryptOperationalRecord(encrypted, context, newKey), {
      voucherNumber: 1,
      debit: 2500,
      credit: 2500,
    });
    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor(oldPassphrase, rewrapped, 'workspace-finance-01')
    );
    await assert.rejects(
      () => rewrapOperationalKeyDescriptor(restored, 'incorrect-passphrase-1405', newPassphrase)
    );
    await assert.rejects(
      () => createOperationalKeyDescriptor(
        'workspace-finance-01',
        'operational-key-1406',
        'short'
      ),
      /at least 10/
    );

    console.log('Operational key descriptor: 44 assertions passed');
  } finally {
    if (previousRandom) Object.defineProperty(webcrypto, 'getRandomValues', previousRandom);
    else Reflect.deleteProperty(webcrypto, 'getRandomValues');
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
