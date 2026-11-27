import assert from 'node:assert/strict';
import {
  MeshReplayGuard,
  computeMeshMessageMacHmacSha256,
  signMeshMessageEnvelopeSecure,
  verifyMeshMessageEnvelopeSecure,
  computeMeshAuthTag,
  type MeshWireMessageBody,
} from '../src/lib/p2pMeshSync';

async function main() {
  assert.ok(globalThis.crypto?.subtle, 'WebCrypto subtle API is required by the P2P security test');
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
  console.log('P2P HMAC-SHA256 v3 tests: 5 assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
