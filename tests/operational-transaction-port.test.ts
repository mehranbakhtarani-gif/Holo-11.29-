import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  commitChequeStatusOperationalTx,
  commitDepreciationOperationalTx,
  commitInvoiceOperationalTx,
  commitSalesOrderDispatchOperationalTx,
  commitStockAdjustmentOperationalTx,
} from '../src/lib/operationalDb';
import { operationalBackupMaintenancePort, operationalDiagnosticsPort, operationalEncryptionPreparationPort, operationalHealthReportPort, operationalResetPort, operationalRecoveryPort, operationalSyncPersistencePort, operationalTransactionPort, operationalWorkspacePersistencePort } from '../src/lib/repositoryAbstraction';
import {
  clearPendingSyncOutboxOperations, enqueueSyncOutboxOperation, getActiveOperationalRestoreJournal,
  isInboxOperationProcessed, isOperationalRestoreBarrierActive, listPendingSyncOutboxOperations,
  loadOperationalWorkspace,
  markSyncOutboxOperationStatus, recordInboxOperation,
  OP_DB_VERSION, savePreUpdateSafetyBackup, saveOperationalWorkspaceTx,
  getOperationalDbStats, getOperationalDbDetailedReport, prepareEncryptedOperationalWorkspaceMigration, wipeAllLocalIndexedDbs, clearHolooLocalStorageKeys,
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
assert.equal(operationalRecoveryPort.getActiveRestoreJournal, getActiveOperationalRestoreJournal);
assert.equal(operationalRecoveryPort.isRestoreBarrierActive, isOperationalRestoreBarrierActive);
assert.equal(operationalRecoveryPort.loadWorkspace, loadOperationalWorkspace);
assert.deepEqual(Object.keys(operationalRecoveryPort).sort(), ['getActiveRestoreJournal','isRestoreBarrierActive','loadWorkspace'].sort());
assert.equal(operationalWorkspacePersistencePort.loadWorkspace, loadOperationalWorkspace);
assert.equal(operationalWorkspacePersistencePort.saveWorkspace, saveOperationalWorkspaceTx);
assert.equal(operationalWorkspacePersistencePort.isRestoreBarrierActive, isOperationalRestoreBarrierActive);
assert.deepEqual(Object.keys(operationalWorkspacePersistencePort).sort(), ['isRestoreBarrierActive','loadWorkspace','saveWorkspace'].sort());
assert.equal(operationalBackupMaintenancePort.databaseVersion, OP_DB_VERSION);
assert.equal(operationalBackupMaintenancePort.savePreUpdateSafetyBackup, savePreUpdateSafetyBackup);
assert.deepEqual(Object.keys(operationalBackupMaintenancePort).sort(), ['databaseVersion','savePreUpdateSafetyBackup'].sort());
assert.equal(operationalDiagnosticsPort.getStats, getOperationalDbStats);
assert.deepEqual(Object.keys(operationalDiagnosticsPort).sort(), ['getStats']);
assert.equal(operationalEncryptionPreparationPort.prepareShadowSnapshot, prepareEncryptedOperationalWorkspaceMigration);
assert.deepEqual(Object.keys(operationalEncryptionPreparationPort).sort(), ['prepareShadowSnapshot']);
assert.equal(operationalHealthReportPort.getDetailedReport, getOperationalDbDetailedReport);
assert.deepEqual(Object.keys(operationalHealthReportPort).sort(), ['getDetailedReport']);
assert.equal(operationalResetPort.wipeAllLocalDatabases, wipeAllLocalIndexedDbs);
assert.equal(operationalResetPort.clearLocalPreferences, clearHolooLocalStorageKeys);
assert.deepEqual(Object.keys(operationalResetPort).sort(), ['clearLocalPreferences','wipeAllLocalDatabases'].sort());

const settingsViewSource = fs.readFileSync(path.join(process.cwd(), 'src/components/SettingsView.tsx'), 'utf8');
assert.match(settingsViewSource, /operationalRecoveryPort/);
assert.doesNotMatch(settingsViewSource, /from ['\"]\.\.\/lib\/operationalDb['\"]/);
const offlinePanelSource = fs.readFileSync(path.join(process.cwd(), 'src/components/OfflineFirstControlPanel.tsx'), 'utf8');
assert.match(offlinePanelSource, /operationalBackupMaintenancePort/);
assert.doesNotMatch(offlinePanelSource, /from ['\"]\.\.\/lib\/operationalDb['\"]/);
const accountingSource = fs.readFileSync(path.join(process.cwd(), 'src/context/AccountingContext.tsx'), 'utf8');
assert.match(accountingSource, /operationalWorkspacePersistencePort/);
assert.match(accountingSource, /operationalDiagnosticsPort/);
assert.match(accountingSource, /operationalEncryptionPreparationPort/);
assert.doesNotMatch(accountingSource, /from ['\"]\.\.\/lib\/operationalDb['\"]/);
const resetSource = fs.readFileSync(path.join(process.cwd(), 'src/components/SystemResetCenter.tsx'), 'utf8');
assert.match(resetSource, /operationalResetPort/);
assert.doesNotMatch(resetSource, /from ['\"]\.\.\/lib\/operationalDb['\"]/);
const healthSource = fs.readFileSync(path.join(process.cwd(), 'src/components/OfflineSyncHealthDashboard.tsx'), 'utf8');
assert.match(healthSource, /operationalHealthReportPort/);
assert.doesNotMatch(healthSource, /from ['\"]\.\.\/lib\/operationalDb['\"]/);
assert.doesNotMatch(accountingSource, /\b(loadOperationalWorkspace|saveOperationalWorkspaceTx|isOperationalRestoreBarrierActive)\b/);
const appSource = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf8');
assert.match(appSource, /import\('\.\/lib\/repositoryAbstraction'\)/);
assert.match(appSource, /operationalBackupMaintenancePort\.savePreUpdateSafetyBackup/);
assert.doesNotMatch(appSource, /import\('\.\/lib\/operationalDb'\)/);
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
