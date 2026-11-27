import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getChangedWorkspaceExtensionKeys,
  mergeRemoteArray,
  mergeWorkspaceExtensionField,
} from '../lib/workspaceExtensionsMerge';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  db,
  handleFirestoreError,
  isFirestoreOfflineError,
  OperationType,
} from '../lib/firebase';
import { useAccounting } from './AccountingContext';
import { isOperationalRestoreBarrierActive } from '../lib/operationalDb';
import {
  BankLoan,
  BomFormula,
  DEFAULT_RECURRING_TEMPLATES,
  DEFAULT_VOLUME_DISCOUNT_RULES,
  DevicePresenceRecord,
  FiscalYearArchive,
  InstallmentPlan,
  MoadianInvoiceMeta,
  PettyCashItem,
  RecurringVoucherTemplate,
  VolumeDiscountRule,
  WarehouseSlip,
  YarnDyeLot,
} from '../lib/apexExtensions';
import {
  DEFAULT_FAVORITE_KEYS,
  loadFavoriteMenus,
  loadProductApexMetaMap,
  loadReservedInvoices,
  ProductApexMeta,
  ReservedInvoice,
} from '../lib/smartIntelligence';
import { ActiveModule } from '../types/accounting';

const LOCAL_EXT_STORAGE_KEY = 'holoo_apex96_workspace_extensions_v2';

export interface WorkspaceExtensionsState {
  reservedInvoices: ReservedInvoice[];
  productMetaMap: Record<string, ProductApexMeta>;
  favoriteMenus: string[];
  pettyCashCeilingIrr: number;
  pettyCashItems: PettyCashItem[];
  recurringTemplates: RecurringVoucherTemplate[];
  bankLoans: BankLoan[];
  dyeLots: YarnDyeLot[];
  warehouseSlips: WarehouseSlip[];
  bomFormulas: BomFormula[];
  installmentPlans: InstallmentPlan[];
  volumeDiscountRules: VolumeDiscountRule[];
  moadianLinks: Record<string, MoadianInvoiceMeta>;
  fiscalArchives: FiscalYearArchive[];
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
        Object.defineProperty(out, k, {
          value: stripUndefinedDeep(v),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return out as T;
  }
  return value;
}

function loadInitialExtensions(): WorkspaceExtensionsState {
  let saved: Partial<WorkspaceExtensionsState> = {};
  try {
    const raw = localStorage.getItem(LOCAL_EXT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        saved = parsed as Partial<WorkspaceExtensionsState>;
      }
    }
  } catch {
    // ignore corrupted local storage
  }

  return {
    reservedInvoices: Array.isArray(saved.reservedInvoices)
      ? saved.reservedInvoices
      : loadReservedInvoices(),
    productMetaMap:
      saved.productMetaMap && typeof saved.productMetaMap === 'object'
        ? saved.productMetaMap
        : loadProductApexMetaMap(),
    favoriteMenus:
      Array.isArray(saved.favoriteMenus) && saved.favoriteMenus.length > 0
        ? saved.favoriteMenus
        : loadFavoriteMenus() || DEFAULT_FAVORITE_KEYS,
    pettyCashCeilingIrr:
      typeof saved.pettyCashCeilingIrr === 'number' && saved.pettyCashCeilingIrr >= 0
        ? saved.pettyCashCeilingIrr
        : 200_000_000,
    pettyCashItems: Array.isArray(saved.pettyCashItems) ? saved.pettyCashItems : [],
    recurringTemplates:
      Array.isArray(saved.recurringTemplates) && saved.recurringTemplates.length > 0
        ? saved.recurringTemplates
        : DEFAULT_RECURRING_TEMPLATES,
    bankLoans: Array.isArray(saved.bankLoans) ? saved.bankLoans : [],
    dyeLots: Array.isArray(saved.dyeLots) ? saved.dyeLots : [],
    warehouseSlips: Array.isArray(saved.warehouseSlips) ? saved.warehouseSlips : [],
    bomFormulas: Array.isArray(saved.bomFormulas) ? saved.bomFormulas : [],
    installmentPlans: Array.isArray(saved.installmentPlans) ? saved.installmentPlans : [],
    volumeDiscountRules:
      Array.isArray(saved.volumeDiscountRules) && saved.volumeDiscountRules.length > 0
        ? saved.volumeDiscountRules
        : DEFAULT_VOLUME_DISCOUNT_RULES,
    moadianLinks:
      saved.moadianLinks && typeof saved.moadianLinks === 'object' ? saved.moadianLinks : {},
    fiscalArchives: Array.isArray(saved.fiscalArchives) ? saved.fiscalArchives : [],
  };
}

interface WorkspaceExtensionsContextValue extends WorkspaceExtensionsState {
  isCloudSynced: boolean;
  updateExtensions: (
    updater: (prev: WorkspaceExtensionsState) => WorkspaceExtensionsState
  ) => void;
  setReservedInvoicesSynced: (items: ReservedInvoice[]) => void;
  upsertProductMetaSynced: (productKey: string, meta: ProductApexMeta) => void;
  setFavoriteMenusSynced: (keys: string[]) => void;
  upsertMoadianMeta: (invoiceId: string, meta: MoadianInvoiceMeta) => void;
  deductDyeLotStock: (lotCode: string, productId: string, kgToDeduct: number) => void;
  // Multi-device live presence & concurrent edit locking
  onlineDevices: DevicePresenceRecord[];
  otherOnlineDevices: DevicePresenceRecord[];
  setPresenceModule: (mod: ActiveModule) => void;
  setEditingLock: (recordKey: string, recordLabel?: string) => void;
  getConflictingDevices: (recordKey: string) => DevicePresenceRecord[];
}

const WorkspaceExtensionsContext = createContext<WorkspaceExtensionsContextValue | null>(null);

export const WorkspaceExtensionsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user, isCloudMode, deviceId, deviceLabel, activeOperator, products } = useAccounting();

  const [state, setState] = useState<WorkspaceExtensionsState>(() => loadInitialExtensions());
  const [onlineDevices, setOnlineDevices] = useState<DevicePresenceRecord[]>([]);
  const [activePresenceModule, setActivePresenceModule] = useState<string>('dashboard');
  const [editingLock, setEditingLockState] = useState<{ key: string; label: string }>({
    key: '',
    label: '',
  });

  const versionRef = useRef(1);
  const cloudWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeCloudUidRef = useRef<string | null>(isCloudMode ? user?.uid ?? null : null);
  const pendingCloudMutationsRef = useRef(0);
  activeCloudUidRef.current = isCloudMode ? user?.uid ?? null : null;
  const hasPresenceDocRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Seed default dye-lots once from existing products if user has none yet
  useEffect(() => {
    if (isOperationalRestoreBarrierActive()) return;
    if (stateRef.current.dyeLots.length === 0 && products.length > 0) {
      const seededLots: YarnDyeLot[] = products
        .filter((p) => p.lotNumber && p.stock > 0)
        .slice(0, 12)
        .map((p, idx) => ({
          id: `lot-seed-${p.id}`,
          productId: p.id,
          productSku: p.sku,
          productName: p.name,
          lotCode: p.lotNumber || `LOT-1405-${idx + 1}`,
          shadeCode: p.category.includes('پنبه') ? 'RAW-COTTON' : 'RAW-WHITE',
          originCountry: p.originCountry || 'چین',
          warehouse: p.warehouse,
          arrivalDate: '1405/01/15',
          initialWeightKg: p.stock,
          remainingWeightKg: p.stock,
          cartonCount:
            p.kgPerCarton && p.kgPerCarton > 0 ? Math.round(p.stock / p.kgPerCarton) : 0,
        }));
      if (seededLots.length > 0) {
        setState((prev) => (prev.dyeLots.length === 0 ? { ...prev, dyeLots: seededLots } : prev));
      }
    }
  }, [products]);

  // Persist local mirror whenever state changes
  const persistLocalMirror = useCallback((next: WorkspaceExtensionsState) => {
    if (isOperationalRestoreBarrierActive()) return;
    // Keep the four compatibility stores convergent if a quota/security error
    // interrupts the write sequence. localStorage has no multi-key transaction,
    // so capture previous values and roll back every key already written.
    const writes: Array<[string, string]> = [
      [LOCAL_EXT_STORAGE_KEY, JSON.stringify(next)],
      ['holoo_apex96_reserved_invoices_v1', JSON.stringify(next.reservedInvoices)],
      ['holoo_apex96_favorite_menus', JSON.stringify(next.favoriteMenus)],
      ['holoo_apex96_product_meta_v1', JSON.stringify(next.productMetaMap)],
    ];
    const previous = writes.map(([key]) => [key, localStorage.getItem(key)] as const);
    let completed = 0;
    try {
      for (const [key, value] of writes) {
        localStorage.setItem(key, value);
        completed += 1;
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (let index = completed - 1; index >= 0; index -= 1) {
        const [key, value] = previous[index];
        try {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(
          `Workspace extension persistence failed and rollback was incomplete: ${String(error)}; ${rollbackErrors.length} rollback error(s)`
        );
      }
      throw error;
    }
  }, []);

  // Serialize local writes and transactionally patch only fields changed by this device.
  // Firestore retries the transaction if another device commits between read and write.
  const pushToCloud = useCallback(
    async (
      next: WorkspaceExtensionsState,
      previous: WorkspaceExtensionsState = next
    ) => {
      if (isOperationalRestoreBarrierActive() || !isCloudMode || !user?.uid) return;
      const cloudUid = user.uid;
      if (activeCloudUidRef.current !== cloudUid) return;

      const docRef = doc(db, 'workspaceExtensions', cloudUid);
      const changedKeys = getChangedWorkspaceExtensionKeys(previous, next);
      const bounded = stripUndefinedDeep({
        reservedInvoices: next.reservedInvoices.slice(0, 50),
        productMetaMap: Object.fromEntries(Object.entries(next.productMetaMap).slice(0, 500)),
        favoriteMenus: next.favoriteMenus.slice(0, 30),
        pettyCashCeilingIrr: Math.max(0, Math.round(next.pettyCashCeilingIrr || 0)),
        pettyCashItems: next.pettyCashItems.slice(0, 200),
        recurringTemplates: next.recurringTemplates.slice(0, 50),
        bankLoans: next.bankLoans.slice(0, 50),
        dyeLots: next.dyeLots.slice(0, 250),
        warehouseSlips: next.warehouseSlips.slice(0, 200),
        bomFormulas: next.bomFormulas.slice(0, 100),
        installmentPlans: next.installmentPlans.slice(0, 120),
        volumeDiscountRules: next.volumeDiscountRules.slice(0, 50),
        moadianLinks: Object.fromEntries(Object.entries(next.moadianLinks).slice(0, 500)),
        fiscalArchives: next.fiscalArchives.slice(0, 25),
      });

      const write = async () => {
        if (isOperationalRestoreBarrierActive() || activeCloudUidRef.current !== cloudUid) return;
        try {
          const committedVersion = await runTransaction(db, async (transaction) => {
            if (activeCloudUidRef.current !== cloudUid) throw new Error('Workspace account changed before cloud write');
            const snap = await transaction.get(docRef);
            if (activeCloudUidRef.current !== cloudUid) throw new Error('Workspace account changed during cloud write');
            if (!snap.exists()) {
              transaction.set(docRef, {
                ownerId: user.uid,
                ...bounded,
                _version: 1,
                updatedByDevice: deviceLabel.slice(0, 120),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
              return 1;
            }

            const remote = snap.data();
            const remoteVersion =
              Number.isSafeInteger(remote._version) && remote._version >= 0
                ? remote._version
                : 0;
            if (remoteVersion >= Number.MAX_SAFE_INTEGER) {
              throw new Error('Workspace extension cloud version limit reached');
            }

            const patch: Record<string, unknown> = {};
            for (const key of changedKeys) {
              const remoteValue = Object.prototype.hasOwnProperty.call(remote, key)
                ? remote[key]
                : previous[key];
              const merged = mergeWorkspaceExtensionField(
                previous[key],
                bounded[key],
                remoteValue
              );
              if (!merged.ok) {
                throw new Error(
                  `Workspace extension concurrent conflict in ${String(key)}: ${merged.conflicts.join(', ')}`
                );
              }
              if (
                (Array.isArray(merged.value) && merged.value.length > (key === 'reservedInvoices' ? 50 :
                  key === 'favoriteMenus' ? 30 : key === 'pettyCashItems' ? 200 :
                  key === 'recurringTemplates' ? 50 : key === 'bankLoans' ? 50 :
                  key === 'dyeLots' ? 250 : key === 'warehouseSlips' ? 200 :
                  key === 'bomFormulas' ? 100 : key === 'installmentPlans' ? 120 :
                  key === 'volumeDiscountRules' ? 50 : key === 'fiscalArchives' ? 25 : Number.MAX_SAFE_INTEGER)) ||
                ((key === 'productMetaMap' || key === 'moadianLinks') &&
                  merged.value && typeof merged.value === 'object' &&
                  Object.keys(merged.value as Record<string, unknown>).length > 500)
              ) {
                throw new Error(`Workspace extension concurrent merge exceeds the cloud limit for ${String(key)}`);
              }
              patch[key as string] = merged.value;
            }
            if (Object.keys(patch).length === 0) return remoteVersion;

            const nextVersion = remoteVersion + 1;
            transaction.update(docRef, {
              ...patch,
              _version: nextVersion,
              updatedByDevice: deviceLabel.slice(0, 120),
              updatedAt: serverTimestamp(),
            });
            return nextVersion;
          });

          versionRef.current = Math.max(versionRef.current, committedVersion);
        } catch (err) {
          if (activeCloudUidRef.current !== cloudUid && err instanceof Error && err.message.includes('Workspace account changed')) return;
          if (!isFirestoreOfflineError(err)) {
            try {
              handleFirestoreError(err, OperationType.WRITE, `workspaceExtensions/${cloudUid}`);
            } catch {
              // logged cleanly
            }
          }
        }
      };

      pendingCloudMutationsRef.current += 1;
      const queuedWrite = cloudWriteQueueRef.current.then(write, write).finally(() => {
        pendingCloudMutationsRef.current = Math.max(0, pendingCloudMutationsRef.current - 1);
      });
      cloudWriteQueueRef.current = queuedWrite;
      await queuedWrite;
    },
    [isCloudMode, user?.uid, deviceLabel]
  );

  // Live Firestore listener for /workspaceExtensions/{uid}
  useEffect(() => {
    if (!isCloudMode || !user?.uid) {
      return;
    }

    const docRef = doc(db, 'workspaceExtensions', user.uid);
    const unsub = onSnapshot(
      docRef,
      (snap) => {
        if (isOperationalRestoreBarrierActive() || activeCloudUidRef.current !== user.uid) return;
        if (pendingCloudMutationsRef.current > 0) return;
        if (!snap.exists()) {
          // Bootstrap cloud extensions from current local workspace
          void pushToCloud(stateRef.current, stateRef.current);
          return;
        }
        const data = snap.data() as Partial<WorkspaceExtensionsState> & { _version?: number };
        if (typeof data._version === 'number') {
          versionRef.current = Math.max(versionRef.current, data._version);
        }
        if (isOperationalRestoreBarrierActive()) return;
        const prev = stateRef.current;
          const merged: WorkspaceExtensionsState = {
            reservedInvoices: Array.isArray(data.reservedInvoices)
              ? data.reservedInvoices
              : prev.reservedInvoices,
            productMetaMap:
              data.productMetaMap && typeof data.productMetaMap === 'object'
                ? data.productMetaMap
                : prev.productMetaMap,
            favoriteMenus: mergeRemoteArray(data.favoriteMenus, prev.favoriteMenus),
            pettyCashCeilingIrr:
              typeof data.pettyCashCeilingIrr === 'number'
                ? data.pettyCashCeilingIrr
                : prev.pettyCashCeilingIrr,
            pettyCashItems: Array.isArray(data.pettyCashItems)
              ? data.pettyCashItems
              : prev.pettyCashItems,
            recurringTemplates: mergeRemoteArray(data.recurringTemplates, prev.recurringTemplates),
            bankLoans: Array.isArray(data.bankLoans) ? data.bankLoans : prev.bankLoans,
            dyeLots: Array.isArray(data.dyeLots) ? data.dyeLots : prev.dyeLots,
            warehouseSlips: Array.isArray(data.warehouseSlips)
              ? data.warehouseSlips
              : prev.warehouseSlips,
            bomFormulas: Array.isArray(data.bomFormulas) ? data.bomFormulas : prev.bomFormulas,
            installmentPlans: Array.isArray(data.installmentPlans)
              ? data.installmentPlans
              : prev.installmentPlans,
            volumeDiscountRules: mergeRemoteArray(data.volumeDiscountRules, prev.volumeDiscountRules),
            moadianLinks:
              data.moadianLinks && typeof data.moadianLinks === 'object'
                ? data.moadianLinks
                : prev.moadianLinks,
            fiscalArchives: Array.isArray(data.fiscalArchives)
              ? data.fiscalArchives
              : prev.fiscalArchives,
          };
        persistLocalMirror(merged);
        stateRef.current = merged;
        setState(merged);
      },
      (err) => {
        if (!isFirestoreOfflineError(err)) {
          try {
            handleFirestoreError(err, OperationType.GET, `workspaceExtensions/${user.uid}`);
          } catch {
            // logged cleanly
          }
        }
      }
    );

    return () => unsub();
  }, [isCloudMode, user?.uid, persistLocalMirror, pushToCloud]);

  // Live Multi-Device Presence Heartbeat & Listener (/devicePresence)
  useEffect(() => {
    if (!isCloudMode || !user?.uid || !deviceId) {
      setOnlineDevices([]);
      hasPresenceDocRef.current = false;
      return;
    }

    const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'dev1';
    const presenceDocId = `${user.uid}_${safeDeviceId}`.slice(0, 120);
    const presenceRef = doc(db, 'devicePresence', presenceDocId);

    const writeHeartbeat = async () => {
      try {
        if (!hasPresenceDocRef.current) {
          const snap = await getDoc(presenceRef);
          hasPresenceDocRef.current = snap.exists();
        }
        const payload = {
          deviceLabel: (deviceLabel || 'دستگاه وب').slice(0, 115),
          operatorName: (activeOperator.fullName || 'مدیر مالی').slice(0, 115),
          activeModule: activePresenceModule.slice(0, 44),
          editingRecordKey: editingLock.key.slice(0, 120),
          editingRecordLabel: editingLock.label.slice(0, 175),
          lastSeenMs: Date.now(),
          updatedAt: serverTimestamp(),
        };
        if (hasPresenceDocRef.current) {
          await updateDoc(presenceRef, payload);
        } else {
          await setDoc(presenceRef, {
            ownerId: user.uid,
            deviceId: safeDeviceId,
            ...payload,
            createdAt: serverTimestamp(),
          });
          hasPresenceDocRef.current = true;
        }
      } catch {
        // non-blocking heartbeat
      }
    };

    void writeHeartbeat();
    const interval = window.setInterval(() => {
      void writeHeartbeat();
    }, 20_000);

    const q = query(collection(db, 'devicePresence'), where('ownerId', '==', user.uid));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const now = Date.now();
        const rows: DevicePresenceRecord[] = [];
        snap.forEach((d) => {
          const data = d.data() as Partial<DevicePresenceRecord>;
          if (typeof data.lastSeenMs === 'number' && now - data.lastSeenMs <= 120_000) {
            rows.push({
              id: d.id,
              ownerId: data.ownerId || user.uid,
              deviceId: data.deviceId || d.id,
              deviceLabel: data.deviceLabel || 'دستگاه متصل',
              operatorName: data.operatorName || 'کاربر',
              activeModule: data.activeModule || 'dashboard',
              editingRecordKey: data.editingRecordKey || '',
              editingRecordLabel: data.editingRecordLabel || '',
              lastSeenMs: data.lastSeenMs,
            });
          }
        });
        setOnlineDevices(rows.sort((a, b) => b.lastSeenMs - a.lastSeenMs));
      },
      () => {
        // ignore transient errors
      }
    );

    const handleBeforeUnload = () => {
      void deleteDoc(presenceRef).catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unsub();
    };
  }, [
    isCloudMode,
    user?.uid,
    deviceId,
    deviceLabel,
    activeOperator.fullName,
    activePresenceModule,
    editingLock.key,
    editingLock.label,
  ]);

  const updateExtensions = useCallback(
    (updater: (prev: WorkspaceExtensionsState) => WorkspaceExtensionsState) => {
      if (isOperationalRestoreBarrierActive()) return;
      // Avoid side effects inside a React state updater: React may replay updater
      // functions. Keep the ref in sync so rapid consecutive actions compose safely.
      const previous = stateRef.current;
      const next = updater(previous);
      persistLocalMirror(next);
      stateRef.current = next;
      setState(next);
      void pushToCloud(next, previous);
    },
    [persistLocalMirror, pushToCloud]
  );

  const setReservedInvoicesSynced = useCallback(
    (items: ReservedInvoice[]) => {
      updateExtensions((prev) => ({ ...prev, reservedInvoices: items.slice(0, 50) }));
    },
    [updateExtensions]
  );

  const upsertProductMetaSynced = useCallback(
    (productKey: string, meta: ProductApexMeta) => {
      updateExtensions((prev) => ({
        ...prev,
        productMetaMap: {
          ...prev.productMetaMap,
          [productKey]: {
            ...prev.productMetaMap[productKey],
            ...meta,
          },
        },
      }));
    },
    [updateExtensions]
  );

  const setFavoriteMenusSynced = useCallback(
    (keys: string[]) => {
      updateExtensions((prev) => ({ ...prev, favoriteMenus: keys.slice(0, 30) }));
    },
    [updateExtensions]
  );

  const upsertMoadianMeta = useCallback(
    (invoiceId: string, meta: MoadianInvoiceMeta) => {
      updateExtensions((prev) => ({
        ...prev,
        moadianLinks: {
          ...prev.moadianLinks,
          [invoiceId]: meta,
        },
      }));
    },
    [updateExtensions]
  );

  const deductDyeLotStock = useCallback(
    (lotCode: string, productId: string, kgToDeduct: number) => {
      if (!lotCode || kgToDeduct <= 0) return;
      updateExtensions((prev) => ({
        ...prev,
        dyeLots: prev.dyeLots.map((lot) =>
          lot.productId === productId && lot.lotCode === lotCode
            ? {
                ...lot,
                remainingWeightKg: Math.max(
                  0,
                  Math.round((lot.remainingWeightKg - kgToDeduct) * 100) / 100
                ),
              }
            : lot
        ),
      }));
    },
    [updateExtensions]
  );

  const setPresenceModule = useCallback((mod: ActiveModule) => {
    setActivePresenceModule(mod);
  }, []);

  const setEditingLock = useCallback((recordKey: string, recordLabel = '') => {
    setEditingLockState((prev) =>
      prev.key === recordKey && prev.label === recordLabel
        ? prev
        : { key: recordKey, label: recordLabel }
    );
  }, []);

  const safeCurrentDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'dev1';

  const otherOnlineDevices = useMemo(
    () => onlineDevices.filter((d) => d.deviceId !== safeCurrentDeviceId),
    [onlineDevices, safeCurrentDeviceId]
  );

  const getConflictingDevices = useCallback(
    (recordKey: string) => {
      if (!recordKey) return [];
      return otherOnlineDevices.filter((d) => d.editingRecordKey === recordKey);
    },
    [otherOnlineDevices]
  );

  const value = useMemo<WorkspaceExtensionsContextValue>(
    () => ({
      ...state,
      isCloudSynced: isCloudMode && Boolean(user?.uid),
      updateExtensions,
      setReservedInvoicesSynced,
      upsertProductMetaSynced,
      setFavoriteMenusSynced,
      upsertMoadianMeta,
      deductDyeLotStock,
      onlineDevices,
      otherOnlineDevices,
      setPresenceModule,
      setEditingLock,
      getConflictingDevices,
    }),
    [
      state,
      isCloudMode,
      user?.uid,
      updateExtensions,
      setReservedInvoicesSynced,
      upsertProductMetaSynced,
      setFavoriteMenusSynced,
      upsertMoadianMeta,
      deductDyeLotStock,
      onlineDevices,
      otherOnlineDevices,
      setPresenceModule,
      setEditingLock,
      getConflictingDevices,
    ]
  );

  return (
    <WorkspaceExtensionsContext.Provider value={value}>
      {children}
    </WorkspaceExtensionsContext.Provider>
  );
};

export function useWorkspaceExtensions() {
  const ctx = useContext(WorkspaceExtensionsContext);
  if (!ctx) {
    throw new Error('useWorkspaceExtensions must be used inside WorkspaceExtensionsProvider');
  }
  return ctx;
}
