import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MeshReplayGuard,
  computeMeshMessageMacHmacSha256,
  signMeshMessageEnvelopeSecure,
  verifyMeshMessageEnvelopeSecure,
  computeMeshAuthTag,
  encryptMeshPayloadAesGcm,
  decryptMeshPayloadAesGcm,
  type MeshWireMessageBody,
} from '../src/lib/p2pMeshSync';

async function main() {
  assert.ok(globalThis.crypto?.subtle, 'WebCrypto subtle API is required by the P2P security test');
  const encryptedPayload = await encryptMeshPayloadAesGcm('test-only-holoo-mesh-secret', '{"ledger":"private"}');
  assert.ok(encryptedPayload.startsWith('mesh_e2ee_v1:'), 'outbound P2P state must use the E2EE envelope');
  assert.equal(
    await decryptMeshPayloadAesGcm('test-only-holoo-mesh-secret', encryptedPayload),
    '{"ledger":"private"}',
    'encrypted P2P state must round-trip'
  );
  await assert.rejects(
    () => decryptMeshPayloadAesGcm('test-only-holoo-mesh-secret', '{"ledger":"plaintext"}'),
    /encryption downgrade/,
    'legacy plaintext P2P state must be rejected rather than accepted as a downgrade'
  );
  await assert.rejects(
    () => decryptMeshPayloadAesGcm('   ', encryptedPayload),
    /passphrase is required/
  );
  await assert.rejects(
    () => decryptMeshPayloadAesGcm('wrong-test-secret', encryptedPayload),
    () => true,
    'wrong mesh passphrases must not decrypt state'
  );
  const [encryptedPrefix, encryptedBody] = encryptedPayload.split(':');
  const tamperedBody = encryptedBody.split('');
  // The first 28 bytes are salt + IV (40 base64 chars); mutate ciphertext,
  // not trailing base64 padding bits that can decode to the original bytes.
  const ciphertextBase64Offset = 40;
  const originalCiphertextChar = tamperedBody[ciphertextBase64Offset];
  tamperedBody[ciphertextBase64Offset] = originalCiphertextChar === 'A' ? 'B' : 'A';
  const tamperedPayload = `${encryptedPrefix}:${tamperedBody.join('')}`;
  await assert.rejects(
    () => decryptMeshPayloadAesGcm('test-only-holoo-mesh-secret', tamperedPayload),
    () => true,
    'tampered mesh ciphertext must fail AES-GCM authentication'
  );
  const passphrase = 'test-only-holoo-mesh-secret';
  const body: MeshWireMessageBody = {
    type: 'mesh:request_state',
    fromPeerId: 'holoo-mesh-mehran-laptop',
    authTag: computeMeshAuthTag(passphrase),
  };
  const now = 1_790_000_000_000;
  const signed = await signMeshMessageEnvelopeSecure(passphrase, body, now);
  assert.match(signed.mac, /^mmac3_[a-f0-9]{64}$/);

  const guard = new MeshReplayGuard();
  const valid = await verifyMeshMessageEnvelopeSecure({
    passphrase,
    expectedPeerId: 'holoo-mesh-mehran-laptop',
    raw: signed,
    replayGuard: guard,
    nowMs: now + 100,
  });
  assert.deepEqual(valid, { ok: true });

  const tampered = { ...signed, sentAtMs: signed.sentAtMs + 1 };
  const rejected = await verifyMeshMessageEnvelopeSecure({
    passphrase,
    expectedPeerId: 'holoo-mesh-mehran-laptop',
    raw: tampered,
    replayGuard: new MeshReplayGuard(),
    nowMs: now + 100,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, 'mac_mismatch');

  await assert.rejects(
    () => computeMeshMessageMacHmacSha256('   ', signed),
    /passphrase is required/
  );
  const meshSource = fs.readFileSync(path.resolve('src/lib/p2pMeshSync.ts'), 'utf8');
  assert.match(meshSource, /if \(isValidMeshPeerId\(targetPeer\)\) \{[\s\S]*?this\.connections\.delete\(targetPeer\);[\s\S]*?pendingConnection\.close\(\);[\s\S]*?this\.schedulePeerReconnect\(targetPeer\);/,
    'peer-unavailable signaling errors must clean up stale pending connections before retrying');
  assert.match(meshSource, /conn\.on\('close',[\s\S]*?this\.schedulePeerReconnect\(remotePeerId\);/,
    'closed WebRTC data channels must schedule reconnection');
  assert.match(meshSource, /conn\.on\('error',[\s\S]*?this\.schedulePeerReconnect\(remotePeerId\);/,
    'failed WebRTC data channels must schedule reconnection');
  assert.match(meshSource, /for \(const timer of this\.peerReconnectTimers\.values\(\)\) window\.clearTimeout\(timer\);/,
    'stopping the mesh connector must clear all peer retry timers');
  console.log('P2P HMAC-SHA256 and reconnect lifecycle tests: 9 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
