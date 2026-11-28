import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createOperationalKeyDescriptor,
  deriveOperationalKeyFromDescriptor,
  isOperationalKeyDescriptor,
  OPERATIONAL_KEY_DESCRIPTOR_VERSION,
} from '../src/lib/operationalKeyDescriptor';

async function run() {
  const previousCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  try {
    const descriptor = createOperationalKeyDescriptor(
      'workspace-finance-01',
      'operational-key-1405'
    );
    assert.equal(descriptor.version, OPERATIONAL_KEY_DESCRIPTOR_VERSION);
    assert.equal(descriptor.workspaceId, 'workspace-finance-01');
    assert.equal(descriptor.cipher, 'AES-256-GCM');
    assert.equal(descriptor.kdf, 'PBKDF2-SHA-256');
    assert.equal(descriptor.iterations, 600_000);
    assert.equal(atob(descriptor.saltB64).length, 16);
    assert.equal(isOperationalKeyDescriptor(descriptor), true);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, version: 99 }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, iterations: 100_000 }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, workspaceId: '' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, keyId: 'bad' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, cipher: 'AES-CBC' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, saltB64: 'not-base64' }), false);
    assert.equal(isOperationalKeyDescriptor({ ...descriptor, createdAt: 'invalid' }), false);

    const restored = JSON.parse(JSON.stringify(descriptor));
    assert.equal(isOperationalKeyDescriptor(restored), true);
    const key = await deriveOperationalKeyFromDescriptor(
      'OperationalEncryption#1405',
      restored,
      'workspace-finance-01'
    );
    assert.equal(key.type, 'secret');
    assert.equal(key.extractable, false);
    assert.deepEqual(key.usages, ['encrypt', 'decrypt']);

    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor(
        'OperationalEncryption#1405',
        restored,
        'workspace-other'
      ),
      /invalid or belongs to another workspace/
    );
    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor('short', restored, 'workspace-finance-01'),
      /at least 10/
    );
    await assert.rejects(
      () => deriveOperationalKeyFromDescriptor(
        'OperationalEncryption#1405',
        { ...restored, saltB64: 'AAAAAAAAAAAAAAAAAAAAAA==' },
        'workspace-finance-01'
      ),
      /invalid|salt/i
    );

    console.log('Operational key descriptor: 20 assertions passed');
  } finally {
    if (previousCrypto) Object.defineProperty(globalThis, 'crypto', previousCrypto);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
