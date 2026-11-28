import assert from 'node:assert/strict';
import {
  commitChequeStatusOperationalTx,
  commitDepreciationOperationalTx,
  commitInvoiceOperationalTx,
  commitSalesOrderDispatchOperationalTx,
  commitStockAdjustmentOperationalTx,
} from '../src/lib/operationalDb';
import { operationalSyncPersistencePort, operationalTransactionPort } from '../src/lib/repositoryAbstraction';
import {
  clearPendingSyncOutboxOperations, enqueueSyncOutboxOperation, getActiveOperationalRestoreJournal,
  isInboxOperationProcessed, isOperationalRestoreBarrierActive, listPendingSyncOutboxOperations,
  markSyncOutboxOperationStatus, recordInboxOperation,
} from '../src/lib/operationalDb';

// The port must remain a transparent delegation layer. Replacing an implementation
// is safe only when the exact atomic IndexedDB command contract is preserved.
assert.equal(operationalTransactionPort.commitInvoice, commitInvoiceOperationalTx);
assert.equal(operationalTransactionPort.dispatchSalesOrder, commitSalesOrderDispatchOperationalTx);
assert.equal(operationalTransactionPort.transitionChequeStatus, commitChequeStatusOperationalTx);
assert.equal(operationalTransactionPort.commitDepreciation, commitDepreciationOperationalTx);
assert.equal(operationalTransactionPort.adjustStock, commitStockAdjustmentOperationalTx);

assert.equal(operationalSyncPersistencePort.enqueueOutbox, enqueueSyncOutboxOperation);
assert.equal(operationalSyncPersistencePort.listPendingOutbox, listPendingSyncOutboxOperations);
assert.equal(operationalSyncPersistencePort.markOutboxStatus, markSyncOutboxOperationStatus);
assert.equal(operationalSyncPersistencePort.clearPendingOutbox, clearPendingSyncOutboxOperations);
assert.equal(operationalSyncPersistencePort.recordInbox, recordInboxOperation);
assert.equal(operationalSyncPersistencePort.hasProcessedInbox, isInboxOperationProcessed);
assert.equal(operationalSyncPersistencePort.getActiveRestoreJournal, getActiveOperationalRestoreJournal);
assert.equal(operationalSyncPersistencePort.isRestoreBarrierActive, isOperationalRestoreBarrierActive);
assert.deepEqual(Object.keys(operationalSyncPersistencePort).sort(), [
  'clearPendingOutbox','enqueueOutbox','getActiveRestoreJournal','hasProcessedInbox',
  'isRestoreBarrierActive','listPendingOutbox','markOutboxStatus','recordInbox',
].sort());

assert.deepEqual(Object.keys(operationalTransactionPort).sort(), [
  'adjustStock',
  'commitDepreciation',
  'commitInvoice',
  'dispatchSalesOrder',
  'transitionChequeStatus',
].sort());

console.log('Operational transaction and sync persistence port contracts passed');
