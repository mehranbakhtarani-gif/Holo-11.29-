import assert from 'node:assert/strict';
import {
  decryptAndVerifyBackupEnvelope,
  encryptBackupEnvelope,
} from '../src/lib/offlineFirstCore';

async function run() {
  const snapshot = JSON.stringify({
    profile: { companyName: 'Security Test', fiscalYear: '1405' },
    accounts: [{ code: '101', title: 'Cash' }],
    vouchers: [],
  });
  const passphrase = 'StrongBackup#1405';
  const envelope = await encryptBackupEnvelope(snapshot, passphrase);

  assert.equal(envelope.kdf, 'PBKDF2-SHA256');
  assert.equal(envelope.cipher, 'AES-256-GCM');
  assert.equal(envelope.iterations, 600_000);
  assert.equal((await decryptAndVerifyBackupEnvelope(JSON.stringify(envelope), passphrase)).ok, true);

  const unsupportedKdf = await decryptAndVerifyBackupEnvelope(
    JSON.stringify({ ...envelope, kdf: 'scrypt' }),
    passphrase
  );
  assert.equal(unsupportedKdf.ok, false);

  const unsupportedCipher = await decryptAndVerifyBackupEnvelope(
    JSON.stringify({ ...envelope, cipher: 'AES-CBC' }),
    passphrase
  );
  assert.equal(unsupportedCipher.ok, false);

  const invalidSalt = await decryptAndVerifyBackupEnvelope(
    JSON.stringify({ ...envelope, saltB64: 'AQID' }),
    passphrase
  );
  assert.equal(invalidSalt.ok, false);

  const invalidIv = await decryptAndVerifyBackupEnvelope(
    JSON.stringify({ ...envelope, ivB64: 'AQID' }),
    passphrase
  );
  assert.equal(invalidIv.ok, false);

  const invalidDigest = await decryptAndVerifyBackupEnvelope(
    JSON.stringify({ ...envelope, plaintextSha256: 'not-a-sha256' }),
    passphrase
  );
  assert.equal(invalidDigest.ok, false);

  console.log('Encrypted backup envelope hardening: 7 assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
