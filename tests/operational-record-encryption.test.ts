import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createOperationalDataSalt,
  decryptOperationalRecord,
  deriveOperationalDataKey,
  encryptOperationalRecord,
} from '../src/lib/operationalRecordEncryption';

async function run() {
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    const salt = createOperationalDataSalt();
    assert.equal(salt.byteLength, 16);
    const originalDeriveKey = webcrypto.subtle.deriveKey.bind(webcrypto.subtle);
    const observedKdfSalts: Uint8Array[] = [];
    Object.defineProperty(webcrypto.subtle, 'deriveKey', {
      configurable: true,
      value: (algorithm: Pbkdf2Params, baseKey: CryptoKey, derivedKeyType: AesKeyGenParams, extractable: boolean, keyUsages: KeyUsage[]) => {
        observedKdfSalts.push(new Uint8Array(algorithm.salt as ArrayBuffer));
        return originalDeriveKey(algorithm, baseKey, derivedKeyType, extractable, keyUsages);
      },
    });
    const key = await deriveOperationalDataKey('OperationalEncryption#1405', salt);
    assert.equal(observedKdfSalts.length, 1, 'PBKDF2 must receive an owned salt buffer');
    assert.ok(
      observedKdfSalts[0].every((byte) => byte === 0),
      'the temporary PBKDF2 salt buffer must be zeroed after derivation'
    );
    Object.defineProperty(webcrypto.subtle, 'deriveKey', {
      configurable: true,
      value: originalDeriveKey,
    });
    assert.equal(key.type, 'secret');
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ['encrypt', 'decrypt']);

    const context = { workspaceId: 'workspace-A', store: 'vouchers' as const, recordId: 'voucher-42' };
    const record = {
      id: 'voucher-42',
      voucherNumber: 'V-1405-0042',
      lines: [{ accountId: '101', debit: 2500, credit: 0 }, { accountId: '201', debit: 0, credit: 2500 }],
    };
    await assert.rejects(
      () => encryptOperationalRecord(undefined, context, key),
      /serialize to a JSON value/,
      'undefined root values must not produce undecryptable ciphertext envelopes'
    );
    const subtle = webcrypto.subtle;
    const originalEncrypt = subtle.encrypt.bind(subtle);
    const encryptionBuffers: Uint8Array[] = [];
    Object.defineProperty(subtle, 'encrypt', {
      configurable: true,
      value: (algorithm: AlgorithmIdentifier | RsaOaepParams | AesCtrParams | AesCbcParams | AesGcmParams, cryptoKey: CryptoKey, data: BufferSource) => {
        if (typeof algorithm === 'object' && 'name' in algorithm && algorithm.name === 'AES-GCM') {
          const params = algorithm as AesGcmParams;
          if (params.iv instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(params.iv));
          if (params.additionalData instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(params.additionalData));
          if (data instanceof ArrayBuffer) encryptionBuffers.push(new Uint8Array(data));
        }
        return originalEncrypt(algorithm, cryptoKey, data);
      },
    });
    const envelope = await encryptOperationalRecord(record, context, key);
    assert.ok(encryptionBuffers.length >= 3, 'record encryption must use owned Web Crypto buffers');
    assert.ok(
      encryptionBuffers.every((buffer) => buffer.every((byte) => byte === 0)),
      'record plaintext, IV, AAD, and Web Crypto copies must be zeroed after encryption'
    );
    Object.defineProperty(subtle, 'encrypt', { configurable: true, value: originalEncrypt });
    assert.equal(envelope.workspaceId, context.workspaceId);
    assert.equal(envelope.store, context.store);
    assert.equal(envelope.recordId, context.recordId);
    assert.notEqual(envelope.ciphertextB64, JSON.stringify(record));
    assert.deepEqual(await decryptOperationalRecord<typeof record>(envelope, context, key), record);

    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, workspaceId: 'workspace-B' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be movable to another workspace'
    );
    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, recordId: 'voucher-43' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be movable to another primary key'
    );
    await assert.rejects(
      () => decryptOperationalRecord(envelope, { ...context, store: 'invoices' }, key),
      /metadata or identity|operation|decrypt/i,
      'ciphertext must not be moved between object stores'
    );

    await assert.rejects(
      () => encryptOperationalRecord(record, { ...context, store: 'meta' as typeof context.store }, key),
      /context is invalid/,
      'runtime callers cannot encrypt into stores outside the approved encrypted-store allowlist'
    );

    const otherKey = await deriveOperationalDataKey('DifferentEncryption#1405', salt);
    await assert.rejects(
      () => decryptOperationalRecord(envelope, context, otherKey),
      /operation|decrypt|authentication/i,
      'wrong keys must fail authentication'
    );

    const tampered = { ...envelope, ciphertextB64: envelope.ciphertextB64.slice(0, -4) + 'AAAA' };
    await assert.rejects(
      () => decryptOperationalRecord(tampered, context, key),
      /operation|decrypt|authentication/i,
      'modified ciphertext must fail authentication'
    );

    await assert.rejects(
      () => decryptOperationalRecord({ ...envelope, ivB64: 'A'.repeat(1_000_000) }, context, key),
      /metadata or identity is invalid/,
      'oversized IV metadata must be rejected before base64 decoding'
    );

    const freshEnvelope = await encryptOperationalRecord(record, context, key);
    assert.notEqual(envelope.ivB64, freshEnvelope.ivB64, 'every record encryption must use a fresh random IV');
    assert.notEqual(envelope.ciphertextB64, freshEnvelope.ciphertextB64);

    await assert.rejects(() => deriveOperationalDataKey('short', salt), /at least 10/);
    await assert.rejects(() => deriveOperationalDataKey('OperationalEncryption#1405', new Uint8Array(8)), /16 bytes/);
    await assert.rejects(
      () => deriveOperationalDataKey('OperationalEncryption#1405', salt, 100_000),
      /work factor/
    );

    // A random-source failure occurs after plaintext encoding. The failure path
    // must still clear the serialized record bytes and the owned ArrayBuffer copy.
    const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    const randomDescriptor = Object.getOwnPropertyDescriptor(webcrypto, 'getRandomValues');
    const originalEncoder = globalThis.TextEncoder;
    const observedPlaintextBuffers: Uint8Array[] = [];
    class TrackingTextEncoder extends originalEncoder {
      encode(input?: string): Uint8Array<ArrayBuffer> {
        const bytes = super.encode(input);
        observedPlaintextBuffers.push(bytes);
        return bytes;
      }
    }
    try {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TrackingTextEncoder });
      Object.defineProperty(webcrypto, 'getRandomValues', {
        configurable: true,
        value: () => { throw new Error('simulated random source failure'); },
      });
      await assert.rejects(
        () => encryptOperationalRecord(record, context, key),
        /simulated random source failure/
      );
      assert.equal(observedPlaintextBuffers.length, 1);
      assert.ok(
        observedPlaintextBuffers[0].every((byte) => byte === 0),
        'plaintext bytes must be cleared when random IV generation fails before encryption'
      );
    } finally {
      if (encoderDescriptor) Object.defineProperty(globalThis, 'TextEncoder', encoderDescriptor);
      else Reflect.deleteProperty(globalThis, 'TextEncoder');
      if (randomDescriptor) Object.defineProperty(webcrypto, 'getRandomValues', randomDescriptor);
      else Reflect.deleteProperty(webcrypto, 'getRandomValues');
    }

    // A failed Web Crypto key import must also clear the encoded passphrase bytes.
    const importDescriptor = Object.getOwnPropertyDescriptor(webcrypto.subtle, 'importKey');
    const kdfEncoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
    const kdfObservedBuffers: Uint8Array[] = [];
    class KdfTrackingTextEncoder extends originalEncoder {
      encode(input?: string): Uint8Array<ArrayBuffer> {
        const bytes = super.encode(input);
        kdfObservedBuffers.push(bytes);
        return bytes;
      }
    }
    try {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: KdfTrackingTextEncoder });
      Object.defineProperty(webcrypto.subtle, 'importKey', {
        configurable: true,
        value: () => { throw new Error('simulated key import failure'); },
      });
      await assert.rejects(
        () => deriveOperationalDataKey('OperationalEncryption#1405', salt),
        /simulated key import failure/
      );
      assert.equal(kdfObservedBuffers.length, 1);
      assert.ok(
        kdfObservedBuffers[0].every((byte) => byte === 0),
        'passphrase bytes must be cleared when Web Crypto key import fails'
      );
    } finally {
      if (kdfEncoderDescriptor) Object.defineProperty(globalThis, 'TextEncoder', kdfEncoderDescriptor);
      else Reflect.deleteProperty(globalThis, 'TextEncoder');
      if (importDescriptor) Object.defineProperty(webcrypto.subtle, 'importKey', importDescriptor);
      else Reflect.deleteProperty(webcrypto.subtle, 'importKey');
    }

    console.log('Operational record encryption codec: 28 assertions passed');
  } finally {
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
