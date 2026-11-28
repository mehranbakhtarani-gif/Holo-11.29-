import assert from 'node:assert/strict';
import {
  commitChequeStatusOperationalTx,
  commitDepreciationOperationalTx,
  commitInvoiceOperationalTx,
  commitSalesOrderDispatchOperationalTx,
  commitStockAdjustmentOperationalTx,
} from '../src/lib/operationalDb';
import { operationalTransactionPort } from '../src/lib/repositoryAbstraction';

// The port must remain a transparent delegation layer. Replacing an implementation
// is safe only when the exact atomic IndexedDB command contract is preserved.
assert.equal(operationalTransactionPort.commitInvoice, commitInvoiceOperationalTx);
assert.equal(operationalTransactionPort.dispatchSalesOrder, commitSalesOrderDispatchOperationalTx);
assert.equal(operationalTransactionPort.transitionChequeStatus, commitChequeStatusOperationalTx);
assert.equal(operationalTransactionPort.commitDepreciation, commitDepreciationOperationalTx);
assert.equal(operationalTransactionPort.adjustStock, commitStockAdjustmentOperationalTx);

assert.deepEqual(Object.keys(operationalTransactionPort).sort(), [
  'adjustStock',
  'commitDepreciation',
  'commitInvoice',
  'dispatchSalesOrder',
  'transitionChequeStatus',
].sort());

console.log('Operational transaction port contract: 6 assertions passed');
