import assert from 'node:assert/strict';
import {
  getOperationalRecordPrimaryKey,
  isEncryptedOperationalRow,
} from '../src/lib/encryptedOperationalRecordAdapter';

function run() {
  const envelope = {
    format: 'holoo-apex-operational-record',
    version: 1,
    workspaceId: 'workspace-A',
    store: 'vouchers',
    recordId: 'voucher-7',
    cipher: 'AES-256-GCM',
    ivB64: 'AAAAAAAAAAAAAAAA',
    ciphertextB64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  };
  const row = { id: 'voucher-7', encryptedRecord: envelope };

  assert.equal(getOperationalRecordPrimaryKey('vouchers', { id: 'voucher-7', date: '1405/01/01' }), 'voucher-7');
  assert.equal(getOperationalRecordPrimaryKey('localProfiles', { workspaceId: 'workspace-A' }), 'workspace-A');
  assert.throws(() => getOperationalRecordPrimaryKey('vouchers', { workspaceId: 'workspace-A' }), /IndexedDB id key/);
  assert.throws(() => getOperationalRecordPrimaryKey('localProfiles', { id: 'profile-1' }), /IndexedDB workspaceId key/);
  assert.equal(isEncryptedOperationalRow('vouchers', row, 'workspace-A'), true);
  assert.equal(isEncryptedOperationalRow('vouchers', row, 'workspace-B'), false);
  assert.equal(isEncryptedOperationalRow('invoices', row, 'workspace-A'), false);
  assert.equal(isEncryptedOperationalRow('vouchers', { ...row, date: '1405/01/01' }, 'workspace-A'), false);
  assert.equal(isEncryptedOperationalRow('vouchers', { ...row, id: 'voucher-8' }, 'workspace-A'), false);
  assert.equal(isEncryptedOperationalRow('vouchers', { id: 'voucher-7', ...envelope }, 'workspace-A'), false);
  assert.equal(isEncryptedOperationalRow('vouchers', null, 'workspace-A'), false);
  assert.equal(isEncryptedOperationalRow('localProfiles', {
    workspaceId: 'workspace-A',
    encryptedRecord: { ...envelope, store: 'localProfiles', recordId: 'workspace-A' },
  }, 'workspace-A'), true);
  console.log('Encrypted operational row adapter: 12 assertions passed');
}

run();
