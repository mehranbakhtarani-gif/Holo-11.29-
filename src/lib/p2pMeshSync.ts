import Peer, { type DataConnection } from 'peerjs';
import {
  MESH_DEVICES,
  type MeshDevicePeerId,
  type MeshSyncEventLog,
  type MeshSyncOutboxItem,
} from './localFolderDexieDb';
import { computeDeterministicHash256 } from './moneyMath';

// ==================== TYPES ====================

export type PeerLinkStatus = 'connected' | 'connecting' | 'offline' | 'error';

export interface MeshPeerRuntimeState {
  peerId: MeshDevicePeerId;
  shortLabel: string;
  fullLabel: string;
  deviceType: 'laptop' | 'phone';
  status: PeerLinkStatus;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface MeshRelayEnvelope {
  operationId: string;
  originDeviceId: string;
  payloadHash: string;
  snapshotJson: string;
  deliveredToPeers: string[];
  requiredPeers: string[];
  createdAt: string;
  summary: string;
}

export interface MeshBatchConfig {
  /** Quiet window (ms) to coalesce consecutive small updates into a single version-vector exchange */
  batchWindowMs: number;
  /** Flush immediately once this many small updates accumulate in the current batch */
  maxBatchSize: number;
  /** Maximum delay (ms) from first queued update before forcing a flush during sustained bursts */
  maxBatchDelayMs: number;
  /** Minimum interval (ms) between duplicate mesh:hello messages with identical hash to the same peer */
  helloMinIntervalMs: number;
}

export const DEFAULT_MESH_BATCH_CONFIG: MeshBatchConfig = {
  batchWindowMs: 3500,
  maxBatchSize: 5,
  maxBatchDelayMs: 10000,
  helloMinIntervalMs: 1500,
};

export interface BatchedUpdateFlushPayload {
  batchedCount: number;
  operationIds: string[];
}

/**
 * Pure adaptive update coalescer that batches rapid small transaction mutations
 * into fewer version-vector exchanges while bounding maximum latency.
 */
export class MeshUpdateBatcher {
  private readonly config: MeshBatchConfig;
  private readonly onFlush: (payload: BatchedUpdateFlushPayload) => void | Promise<void>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingOpIds = new Set<string>();
  private pendingCount = 0;
  private disposed = false;

  constructor(
    onFlush: (payload: BatchedUpdateFlushPayload) => void | Promise<void>,
    config?: Partial<MeshBatchConfig>
  ) {
    this.onFlush = onFlush;
    this.config = { ...DEFAULT_MESH_BATCH_CONFIG, ...(config || {}) };
  }

  public enqueue(operationId?: string): void {
    if (this.disposed) return;
    this.pendingCount += 1;
    if (operationId) {
      this.pendingOpIds.add(operationId);
    }

    if (this.pendingCount >= this.config.maxBatchSize) {
      void this.flushNow();
      return;
    }

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flushNow();
    }, this.config.batchWindowMs);

    if (this.maxDelayTimer === null) {
      this.maxDelayTimer = setTimeout(() => {
        void this.flushNow();
      }, this.config.maxBatchDelayMs);
    }
  }

  public flushNow(): BatchedUpdateFlushPayload | null {
    this.clearTimers();
    if (this.disposed || this.pendingCount === 0) return null;
    const payload: BatchedUpdateFlushPayload = {
      batchedCount: this.pendingCount,
      operationIds: Array.from(this.pendingOpIds),
    };
    this.pendingCount = 0;
    this.pendingOpIds.clear();
    void this.onFlush(payload);
    return payload;
  }

  public getPendingCount(): number {
    return this.pendingCount;
  }

  public clear(): void {
    this.clearTimers();
    this.pendingCount = 0;
    this.pendingOpIds.clear();
  }

  public dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxDelayTimer !== null) {
      clearTimeout(this.maxDelayTimer);
      this.maxDelayTimer = null;
    }
  }
}

/**
 * Compacts relay envelopes for a specific remote peer:
 * - Excludes envelopes already delivered to that peer.
 * - Strips redundant full snapshotJson copies when the main payloadHash or a newer envelope
 *   from the same origin already carries that state, keeping only operation metadata for ACKs & relay tracking.
 */
export function compactRelayEnvelopesForPeer(
  envelopes: MeshRelayEnvelope[],
  targetPeerId: MeshDevicePeerId,
  mainPayloadHash: string
): MeshRelayEnvelope[] {
  const undelivered = envelopes.filter(
    (env) => !(env.deliveredToPeers || []).includes(targetPeerId)
  );
  if (undelivered.length === 0) return [];

  // Track the single newest envelope per originDeviceId that still needs an explicit snapshotJson
  const newestIndexByOrigin = new Map<string, number>();
  for (let i = 0; i < undelivered.length; i++) {
    const env = undelivered[i];
    const prevIdx = newestIndexByOrigin.get(env.originDeviceId);
    if (prevIdx === undefined) {
      newestIndexByOrigin.set(env.originDeviceId, i);
    } else if ((env.createdAt || '') > (undelivered[prevIdx].createdAt || '')) {
      newestIndexByOrigin.set(env.originDeviceId, i);
    }
  }

  return undelivered.map((env, idx) => {
    const isNewestForOrigin = newestIndexByOrigin.get(env.originDeviceId) === idx;
    const coveredByMainSnapshot = env.payloadHash === mainPayloadHash;
    // Only keep snapshotJson if this is the newest envelope for a different origin AND not already identical to main payload
    const keepSnapshot = isNewestForOrigin && !coveredByMainSnapshot;
    return {
      ...env,
      snapshotJson: keepSnapshot ? env.snapshotJson : '',
    };
  });
}

export interface VectorExchangeDecision {
  inSync: boolean;
  shouldRequestRemoteState: boolean;
  shouldSendLocalState: boolean;
}

/**
 * Deterministic handshake evaluator that prevents redundant bidirectional full-state pushes
 * when two peers exchange version vectors (`mesh:hello`).
 */
export function evaluateVectorExchangeDecision(params: {
  localClock: Record<string, number>;
  remoteClock: Record<string, number>;
  localHash: string;
  remoteHash: string;
  localPeerId: MeshDevicePeerId;
  remotePeerId: MeshDevicePeerId;
  remotePendingRelayIds: string[];
  localPendingRelayCountForRemote: number;
}): VectorExchangeDecision {
  const {
    localClock,
    remoteClock,
    localHash,
    remoteHash,
    localPeerId,
    remotePeerId,
    remotePendingRelayIds,
    localPendingRelayCountForRemote,
  } = params;

  const allKeys = new Set([
    ...Object.keys(localClock || {}),
    ...Object.keys(remoteClock || {}),
  ]);

  let remoteStrictlyNewer = false;
  let localStrictlyNewer = false;

  for (const key of allKeys) {
    const lv = Number(localClock?.[key] || 0);
    const rv = Number(remoteClock?.[key] || 0);
    if (rv > lv) remoteStrictlyNewer = true;
    if (lv > rv) localStrictlyNewer = true;
  }

  const hashesDiffer = Boolean(localHash && remoteHash && localHash !== remoteHash);
  const remoteHasRelays = remotePendingRelayIds.length > 0;
  const localHasRelays = localPendingRelayCountForRemote > 0;

  if (!hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && !remoteHasRelays && !localHasRelays) {
    return { inSync: true, shouldRequestRemoteState: false, shouldSendLocalState: false };
  }

  // If hashes differ with equal clocks, use deterministic peerId tie-break to avoid double-pushing simultaneously
  const tieBreakLocalInitiates =
    hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && localPeerId < remotePeerId;
  const tieBreakRemoteInitiates =
    hashesDiffer && !remoteStrictlyNewer && !localStrictlyNewer && remotePeerId < localPeerId;

  return {
    inSync: false,
    shouldRequestRemoteState: remoteStrictlyNewer || remoteHasRelays || tieBreakRemoteInitiates,
    shouldSendLocalState: localStrictlyNewer || localHasRelays || tieBreakLocalInitiates,
  };
}

export interface MeshEnvelopeSecurityFields {
  /** Cryptographic random per-message nonce (128-bit hex) preventing replay attacks */
  nonce: string;
  /** Unix epoch milliseconds when the message was signed (enforces ±5 min freshness window) */
  sentAtMs: number;
  /** Keyed 256-bit MAC authenticating header + payload + nonce + timestamp against forgery/tampering */
  mac: string;
}

export type MeshWireMessageBody =
  | {
      type: 'mesh:hello';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      updatedAt: string;
      payloadHash: string;
      vectorClock: Record<string, number>;
      pendingRelayIds: string[];
      batchedCount?: number;
    }
  | {
      type: 'mesh:request_state';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
    }
  | {
      type: 'mesh:state_payload';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      updatedAt: string;
      payloadHash: string;
      vectorClock: Record<string, number>;
      snapshotJson: string;
      relayEnvelopes: MeshRelayEnvelope[];
      batchedOperationIds?: string[];
    }
  | {
      type: 'mesh:ack';
      fromPeerId: MeshDevicePeerId;
      authTag: string;
      receivedOperationIds: string[];
      payloadHash: string;
      syncedAt: string;
    };

export type MeshWireMessage = MeshWireMessageBody & MeshEnvelopeSecurityFields;

export const MAX_MESH_CLOCK_SKEW_MS = 5 * 60 * 1000; // ±5 minutes
export const MAX_SEEN_NONCES = 2048; // Hard memory ceiling for replay protection cache
export const MAX_MESH_SNAPSHOT_BYTES = 16 * 1024 * 1024; // 16 MB max snapshot payload per packet

const DEVICE_ROLE_STORAGE_KEY = 'holoo_apex_mesh_device_peer_id_v1';
const MESH_PASSPHRASE_KEY = 'holoo_apex_mesh_passphrase_v1';
const MESH_CLOCK_STORAGE_KEY = 'holoo_apex_mesh_vector_clock_v1';

export function isValidMeshPeerId(val: unknown): val is MeshDevicePeerId {
  return (
    val === 'holoo-mesh-mehran-laptop' ||
    val === 'holoo-mesh-mehran-phone1' ||
    val === 'holoo-mesh-mehran-phone2'
  );
}

export function loadSelectedMeshPeerId(): MeshDevicePeerId | null {
  try {
    const raw = localStorage.getItem(DEVICE_ROLE_STORAGE_KEY);
    return isValidMeshPeerId(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveSelectedMeshPeerId(peerId: MeshDevicePeerId): void {
  try {
    localStorage.setItem(DEVICE_ROLE_STORAGE_KEY, peerId);
  } catch {
    // ignore
  }
}

export const LEGACY_INSECURE_MESH_PASSPHRASE = 'holoo-apex-private-mesh';

export function isWeakMeshPassphrase(passphrase: string): boolean {
  const clean = (passphrase || '').trim();
  return clean.length < 10 || clean === LEGACY_INSECURE_MESH_PASSPHRASE;
}

export function generateSecureMeshPassphrase(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `hx-${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}-${hex.slice(24, 32)}`;
  }
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return `hx-${rand}`;
}

export function loadMeshPassphrase(): string {
  try {
    const raw = localStorage.getItem(MESH_PASSPHRASE_KEY);
    if (raw && raw.trim().length >= 4 && raw.trim() !== LEGACY_INSECURE_MESH_PASSPHRASE) {
      return raw.trim();
    }
    // Auto-generate and persist a unique per-workspace cryptographic pairing passphrase
    // instead of falling back to a hardcoded public literal.
    const generated = generateSecureMeshPassphrase();
    localStorage.setItem(MESH_PASSPHRASE_KEY, generated);
    return generated;
  } catch {
    return generateSecureMeshPassphrase();
  }
}

export function saveMeshPassphrase(passphrase: string): void {
  try {
    const clean = passphrase.trim();
    if (clean.length >= 4) {
      localStorage.setItem(MESH_PASSPHRASE_KEY, clean);
    }
  } catch {
    // ignore
  }
}

const MESH_E2EE_PREFIX = 'mesh_e2ee_v1:';

function toBase64Bytes(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64Bytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveMeshAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase.trim()),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Computes a true WebCrypto HMAC-SHA256 digest (hex) for cryptographic peer authentication */
export async function computeWebCryptoHmacSha256(passphrase: string, message: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto subtle API unavailable');
  }
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Encrypts a P2P mesh snapshot payload end-to-end with AES-256-GCM (PBKDF2-SHA256 key derivation) */
export async function encryptMeshPayloadAesGcm(passphrase: string, plaintext: string): Promise<string> {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new Error('WebCrypto AES-GCM unavailable; refusing to transmit an unencrypted P2P payload.');
  }
  if (!passphrase.trim()) {
    throw new Error('P2P encryption passphrase is required.');
  }
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(salt);
  globalThis.crypto.getRandomValues(iv);
  const key = await deriveMeshAesKey(passphrase, salt);
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(16 + 12 + cipherBuf.byteLength);
  combined.set(salt, 0);
  combined.set(iv, 16);
  combined.set(new Uint8Array(cipherBuf), 28);
  return `${MESH_E2EE_PREFIX}${toBase64Bytes(combined)}`;
}

/** Decrypts an AES-256-GCM P2P mesh payload; rejects any tampered or wrong-passphrase ciphertext */
export async function decryptMeshPayloadAesGcm(passphrase: string, payload: string): Promise<string> {
  if (!payload.startsWith(MESH_E2EE_PREFIX)) {
    return payload;
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto subtle API unavailable to decrypt E2EE P2P payload');
  }
  const raw = fromBase64Bytes(payload.slice(MESH_E2EE_PREFIX.length));
  if (raw.length <= 28) {
    throw new Error('Malformed encrypted P2P payload');
  }
  const salt = new Uint8Array(raw.subarray(0, 16));
  const iv = new Uint8Array(raw.subarray(16, 28));
  const ciphertext = new Uint8Array(raw.subarray(28));
  const key = await deriveMeshAesKey(passphrase, salt);
  const plainBuf = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plainBuf);
}

export function loadVectorClock(): Record<string, number> {
  try {
    const raw = localStorage.getItem(MESH_CLOCK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveVectorClock(clock: Record<string, number>): void {
  try {
    localStorage.setItem(MESH_CLOCK_STORAGE_KEY, JSON.stringify(clock));
  } catch {
    // ignore
  }
}

export function getOtherMeshPeerIds(myPeerId: MeshDevicePeerId): MeshDevicePeerId[] {
  return MESH_DEVICES.map((d) => d.peerId).filter((id) => id !== myPeerId);
}

/** Deterministic lightweight mesh auth tag derived from shared private mesh passphrase */
export function computeMeshAuthTag(passphrase: string, namespace = 'holoo-mesh-v1'): string {
  const input = `${namespace}::${passphrase.trim()}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `mtag_${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}`;
}

/** Constant-time string equality check to resist timing side-channels on MAC/authTag checks */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** Generates a 128-bit cryptographically random nonce (hex) for each P2P wire message */
export function generateMeshNonce(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Safe fallback for exotic runtimes lacking Web Crypto
  const t = Date.now().toString(16).padStart(12, '0');
  const r1 = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const r2 = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const r3 = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${t}${r1}${r2}${r3}`.slice(0, 32);
}

function canonicalizeVectorClock(clock: Record<string, number> | undefined): string {
  if (!clock || typeof clock !== 'object') return '';
  return Object.keys(clock)
    .sort()
    .map((k) => `${k}:${Number(clock[k]) || 0}`)
    .join(',');
}

function canonicalizeRelayEnvelopesDigest(relays: MeshRelayEnvelope[] | undefined): string {
  if (!Array.isArray(relays) || relays.length === 0) return '0';
  const parts = relays.map(
    (r) =>
      `${r.operationId}|${r.originDeviceId}|${r.payloadHash}|${computeDeterministicHash256(r.snapshotJson || '')}|${(r.deliveredToPeers || []).slice().sort().join(',')}|${(r.requiredPeers || []).slice().sort().join(',')}`
  );
  return computeDeterministicHash256(parts.join('\n'));
}

export type UnsignedMeshWireMessage = MeshWireMessageBody & Omit<MeshEnvelopeSecurityFields, 'mac'>;

/**
 * Computes a double-keyed 256-bit HMAC-style message authentication code binding
 * every security-critical field of a MeshWireMessage (including nonce, timestamp,
 * peer ID, vector clock, snapshot payload, and relay envelopes).
 */
function buildMeshMessageMacCanonical(msg: UnsignedMeshWireMessage): string {
  let bodyCanonical = '';

  if (msg.type === 'mesh:hello') {
    bodyCanonical = [
      msg.updatedAt || '',
      msg.payloadHash || '',
      canonicalizeVectorClock(msg.vectorClock),
      Array.isArray(msg.pendingRelayIds) ? msg.pendingRelayIds.join(',') : '',
      String(msg.batchedCount ?? ''),
    ].join('|');
  } else if (msg.type === 'mesh:request_state') {
    bodyCanonical = 'req';
  } else if (msg.type === 'mesh:state_payload') {
    const snapDigest = computeDeterministicHash256(
      typeof msg.snapshotJson === 'string' ? msg.snapshotJson : ''
    );
    const relayDigest = canonicalizeRelayEnvelopesDigest(msg.relayEnvelopes);
    const batchIds = Array.isArray(msg.batchedOperationIds)
      ? msg.batchedOperationIds.join(',')
      : '';
    bodyCanonical = [
      msg.updatedAt || '',
      msg.payloadHash || '',
      canonicalizeVectorClock(msg.vectorClock),
      snapDigest,
      relayDigest,
      batchIds,
    ].join('|');
  } else if (msg.type === 'mesh:ack') {
    bodyCanonical = [
      Array.isArray(msg.receivedOperationIds) ? msg.receivedOperationIds.join(',') : '',
      msg.payloadHash || '',
      msg.syncedAt || '',
    ].join('|');
  }

  const envelopeCanonical = [
    'holoo-mesh-mac-v2',
    msg.type,
    msg.fromPeerId,
    msg.authTag,
    msg.nonce,
    String(msg.sentAtMs),
    bodyCanonical,
  ].join('\u001f');

  return envelopeCanonical;
}

export function computeMeshMessageMac(
  passphrase: string,
  msg: UnsignedMeshWireMessage
): string {
  const key = passphrase.trim();
  let bodyCanonical = '';

  if (msg.type === 'mesh:hello') {
    bodyCanonical = [
      msg.updatedAt || '',
      msg.payloadHash || '',
      canonicalizeVectorClock(msg.vectorClock),
      Array.isArray(msg.pendingRelayIds) ? msg.pendingRelayIds.join(',') : '',
      String(msg.batchedCount ?? ''),
    ].join('|');
  } else if (msg.type === 'mesh:request_state') {
    bodyCanonical = 'req';
  } else if (msg.type === 'mesh:state_payload') {
    const snapDigest = computeDeterministicHash256(
      typeof msg.snapshotJson === 'string' ? msg.snapshotJson : ''
    );
    const relayDigest = canonicalizeRelayEnvelopesDigest(msg.relayEnvelopes);
    const batchIds = Array.isArray(msg.batchedOperationIds)
      ? msg.batchedOperationIds.join(',')
      : '';
    bodyCanonical = [
      msg.updatedAt || '',
      msg.payloadHash || '',
      canonicalizeVectorClock(msg.vectorClock),
      snapDigest,
      relayDigest,
      batchIds,
    ].join('|');
  } else if (msg.type === 'mesh:ack') {
    bodyCanonical = [
      Array.isArray(msg.receivedOperationIds) ? msg.receivedOperationIds.join(',') : '',
      msg.payloadHash || '',
      msg.syncedAt || '',
    ].join('|');
  }

  const envelopeCanonical = [
    'holoo-mesh-mac-v2',
    msg.type,
    msg.fromPeerId,
    msg.authTag,
    msg.nonce,
    String(msg.sentAtMs),
    bodyCanonical,
  ].join('\u001f');

  const innerDigest = computeDeterministicHash256(`ipad:${key}:${envelopeCanonical}`);
  return `mmac2_${computeDeterministicHash256(`opad:${key}:${innerDigest}`)}`;
}

/** HMAC-SHA256 MAC v3. The async API is used by all live mesh transport paths. */
export async function computeMeshMessageMacHmacSha256(
  passphrase: string,
  msg: UnsignedMeshWireMessage
): Promise<string> {
  if (!passphrase.trim()) throw new Error('P2P authentication passphrase is required.');
  const digest = await computeWebCryptoHmacSha256(passphrase, buildMeshMessageMacCanonical(msg));
  return `mmac3_${digest}`;
}

export async function signMeshMessageEnvelopeSecure<T extends MeshWireMessageBody>(
  passphrase: string,
  body: T,
  nowMs = Date.now()
): Promise<T & MeshEnvelopeSecurityFields> {
  const unsigned = { ...body, nonce: generateMeshNonce(), sentAtMs: Math.trunc(nowMs) };
  const mac = await computeMeshMessageMacHmacSha256(passphrase, unsigned as UnsignedMeshWireMessage);
  return { ...unsigned, mac };
}

/** Signs an outgoing MeshWireMessageBody with a fresh 128-bit nonce, timestamp, and 256-bit keyed MAC */
export function signMeshMessageEnvelope<T extends MeshWireMessageBody>(
  passphrase: string,
  body: T,
  nowMs = Date.now()
): T & MeshEnvelopeSecurityFields {
  const nonce = generateMeshNonce();
  const sentAtMs = Math.trunc(nowMs);
  const unsigned = {
    ...body,
    nonce,
    sentAtMs,
  };
  const mac = computeMeshMessageMac(passphrase, unsigned as UnsignedMeshWireMessage);
  return {
    ...unsigned,
    mac,
  };
}

export type MeshVerifyFailureReason =
  | 'invalid_structure'
  | 'invalid_peer'
  | 'auth_tag_mismatch'
  | 'missing_security_fields'
  | 'timestamp_out_of_window'
  | 'replay_detected'
  | 'mac_mismatch'
  | 'payload_too_large';

export type MeshVerifyResult =
  | { ok: true }
  | { ok: false; reason: MeshVerifyFailureReason; detail: string };

/**
 * Bounded-memory replay & timestamp-skew guard for P2P mesh packets.
 * Automatically evicts expired nonces and caps resident entries at `maxEntries`
 * so memory consumption stays strictly bounded even under sustained packet floods.
 */
export class MeshReplayGuard {
  private readonly maxSkewMs: number;
  private readonly maxEntries: number;
  private readonly seenNonces = new Map<string, number>();

  constructor(maxSkewMs = MAX_MESH_CLOCK_SKEW_MS, maxEntries = MAX_SEEN_NONCES) {
    this.maxSkewMs = maxSkewMs;
    this.maxEntries = Math.max(16, maxEntries);
  }

  public pruneExpired(nowMs = Date.now()): void {
    const expiryCutoff = nowMs - this.maxSkewMs;
    for (const [key, ts] of this.seenNonces.entries()) {
      if (ts < expiryCutoff) {
        this.seenNonces.delete(key);
      }
    }
  }

  public checkAndRecord(
    fromPeerId: string,
    nonce: string,
    sentAtMs: number,
    nowMs = Date.now()
  ): MeshVerifyResult {
    if (!Number.isFinite(sentAtMs) || Math.abs(nowMs - sentAtMs) > this.maxSkewMs) {
      return {
        ok: false,
        reason: 'timestamp_out_of_window',
        detail: `Message timestamp drift exceeds ±${Math.round(this.maxSkewMs / 1000)}s window`,
      };
    }

    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) {
      return {
        ok: false,
        reason: 'missing_security_fields',
        detail: 'Invalid or missing cryptographic nonce',
      };
    }

    this.pruneExpired(nowMs);
    const cacheKey = `${fromPeerId}:${nonce}`;
    if (this.seenNonces.has(cacheKey)) {
      return {
        ok: false,
        reason: 'replay_detected',
        detail: `Duplicate nonce replay detected from ${fromPeerId}`,
      };
    }

    // Enforce strict upper memory bound by evicting oldest entries first (Map preserves insertion order)
    while (this.seenNonces.size >= this.maxEntries) {
      const oldestKey = this.seenNonces.keys().next().value;
      if (oldestKey === undefined) break;
      this.seenNonces.delete(oldestKey);
    }

    this.seenNonces.set(cacheKey, nowMs);
    return { ok: true };
  }

  public getSize(): number {
    return this.seenNonces.size;
  }

  public clear(): void {
    this.seenNonces.clear();
  }
}

/**
 * Verifies an inbound P2P wire message end-to-end:
 * 1. Allowlisted peer identity & expected sender match
 * 2. Shared passphrase authTag (constant-time)
 * 3. Payload size DoS cap (<= 16 MB)
 * 4. Presence of nonce, timestamp, and MAC
 * 5. Keyed 256-bit MAC integrity check (detects any 1-byte tampering or forgery)
 * 6. Timestamp freshness window (±5 min) + bounded-memory nonce replay check
 *
 * Note: MAC is verified BEFORE recording the nonce so an attacker cannot pollute
 * the replay cache with forged packets.
 */
export function verifyMeshMessageEnvelope(params: {
  passphrase: string;
  expectedPeerId: MeshDevicePeerId;
  raw: unknown;
  replayGuard: MeshReplayGuard;
  nowMs?: number;
  maxPayloadBytes?: number;
}): MeshVerifyResult {
  const {
    passphrase,
    expectedPeerId,
    raw,
    replayGuard,
    nowMs = Date.now(),
    maxPayloadBytes = MAX_MESH_SNAPSHOT_BYTES,
  } = params;

  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'invalid_structure', detail: 'Non-object wire payload' };
  }

  const msg = raw as Partial<MeshWireMessage>;
  if (!isValidMeshPeerId(msg.fromPeerId) || msg.fromPeerId !== expectedPeerId) {
    return { ok: false, reason: 'invalid_peer', detail: 'Sender peerId is not allowlisted or mismatches connection' };
  }

  const expectedTag = computeMeshAuthTag(passphrase);
  if (typeof msg.authTag !== 'string' || !constantTimeEqual(msg.authTag, expectedTag)) {
    return { ok: false, reason: 'auth_tag_mismatch', detail: 'Shared passphrase authTag mismatch' };
  }

  if (
    typeof msg.nonce !== 'string' ||
    typeof msg.sentAtMs !== 'number' ||
    typeof msg.mac !== 'string' ||
    !msg.mac.startsWith('mmac2_')
  ) {
    return {
      ok: false,
      reason: 'missing_security_fields',
      detail: 'Missing nonce, sentAtMs, or keyed MAC v2',
    };
  }

  // Enforce strict memory/DoS cap BEFORE hashing huge strings
  if (msg.type === 'mesh:state_payload') {
    const snapBytes = typeof msg.snapshotJson === 'string' ? msg.snapshotJson.length * 2 : 0;
    const relayBytes = Array.isArray(msg.relayEnvelopes)
      ? msg.relayEnvelopes.reduce((sum, r) => sum + (typeof r?.snapshotJson === 'string' ? r.snapshotJson.length * 2 : 0), 0)
      : 0;
    if (snapBytes + relayBytes > maxPayloadBytes) {
      return {
        ok: false,
        reason: 'payload_too_large',
        detail: `Inbound mesh snapshot exceeds ${Math.round(maxPayloadBytes / (1024 * 1024))}MB safety cap`,
      };
    }
  }

  // Verify timestamp window before heavy MAC hashing if grossly expired/future
  if (!Number.isFinite(msg.sentAtMs) || Math.abs(nowMs - msg.sentAtMs) > MAX_MESH_CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: 'timestamp_out_of_window',
      detail: 'Message timestamp outside allowed ±5 minute freshness window',
    };
  }

  const expectedMac = computeMeshMessageMac(passphrase, msg as UnsignedMeshWireMessage);
  if (!constantTimeEqual(msg.mac, expectedMac)) {
    return {
      ok: false,
      reason: 'mac_mismatch',
      detail: 'Message MAC verification failed (possible forgery or tampering)',
    };
  }

  // Record nonce ONLY after MAC passes to prevent replay-cache pollution
  return replayGuard.checkAndRecord(msg.fromPeerId, msg.nonce, msg.sentAtMs, nowMs);
}

export async function verifyMeshMessageEnvelopeSecure(params: {
  passphrase: string;
  expectedPeerId: MeshDevicePeerId;
  raw: unknown;
  replayGuard: MeshReplayGuard;
  nowMs?: number;
  maxPayloadBytes?: number;
}): Promise<MeshVerifyResult> {
  const {
    passphrase,
    expectedPeerId,
    raw,
    replayGuard,
    nowMs = Date.now(),
    maxPayloadBytes = MAX_MESH_SNAPSHOT_BYTES,
  } = params;

  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'invalid_structure', detail: 'Non-object wire payload' };
  }

  const msg = raw as Partial<MeshWireMessage>;
  if (!isValidMeshPeerId(msg.fromPeerId) || msg.fromPeerId !== expectedPeerId) {
    return { ok: false, reason: 'invalid_peer', detail: 'Sender peerId is not allowlisted or mismatches connection' };
  }

  const expectedTag = computeMeshAuthTag(passphrase);
  if (typeof msg.authTag !== 'string' || !constantTimeEqual(msg.authTag, expectedTag)) {
    return { ok: false, reason: 'auth_tag_mismatch', detail: 'Shared passphrase authTag mismatch' };
  }

  if (
    typeof msg.nonce !== 'string' ||
    typeof msg.sentAtMs !== 'number' ||
    typeof msg.mac !== 'string' ||
    !msg.mac.startsWith('mmac3_')
  ) {
    return {
      ok: false,
      reason: 'missing_security_fields',
      detail: 'Missing nonce, sentAtMs, or HMAC-SHA256 MAC v3',
    };
  }

  // Enforce strict memory/DoS cap BEFORE hashing huge strings
  if (msg.type === 'mesh:state_payload') {
    const snapBytes = typeof msg.snapshotJson === 'string' ? msg.snapshotJson.length * 2 : 0;
    const relayBytes = Array.isArray(msg.relayEnvelopes)
      ? msg.relayEnvelopes.reduce((sum, r) => sum + (typeof r?.snapshotJson === 'string' ? r.snapshotJson.length * 2 : 0), 0)
      : 0;
    if (snapBytes + relayBytes > maxPayloadBytes) {
      return {
        ok: false,
        reason: 'payload_too_large',
        detail: `Inbound mesh snapshot exceeds ${Math.round(maxPayloadBytes / (1024 * 1024))}MB safety cap`,
      };
    }
  }

  // Verify timestamp window before heavy MAC hashing if grossly expired/future
  if (!Number.isFinite(msg.sentAtMs) || Math.abs(nowMs - msg.sentAtMs) > MAX_MESH_CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: 'timestamp_out_of_window',
      detail: 'Message timestamp outside allowed ±5 minute freshness window',
    };
  }

  const expectedMac = await computeMeshMessageMacHmacSha256(passphrase, msg as UnsignedMeshWireMessage);
  if (!constantTimeEqual(msg.mac, expectedMac)) {
    return {
      ok: false,
      reason: 'mac_mismatch',
      detail: 'Message MAC verification failed (possible forgery or tampering)',
    };
  }

  // Record nonce ONLY after MAC passes to prevent replay-cache pollution
  return replayGuard.checkAndRecord(msg.fromPeerId, msg.nonce, msg.sentAtMs, nowMs);
}

// ==================== PEERJS 3-DEVICE MESH CONTROLLER ====================

export interface MeshSyncCallbacks {
  getLocalSnapshot: () => {
    snapshotJson: string;
    payloadHash: string;
    updatedAt: string;
    vectorClock: Record<string, number>;
  };
  getPendingRelayEnvelopes: () => Promise<MeshRelayEnvelope[]>;
  onRemoteStateReceived: (params: {
    fromPeerId: MeshDevicePeerId;
    snapshotJson: string;
    payloadHash: string;
    vectorClock: Record<string, number>;
    relayEnvelopes: MeshRelayEnvelope[];
    batchedOperationIds?: string[];
  }) => Promise<string[]>;
  onPeerAckReceived: (params: {
    fromPeerId: MeshDevicePeerId;
    receivedOperationIds: string[];
    syncedAt: string;
  }) => Promise<void>;
  onStatusChange: (peers: MeshPeerRuntimeState[], selfOnline: boolean, selfError: string | null) => void;
  onSyncEvent?: (event: Omit<MeshSyncEventLog, 'id'>) => void;
}

function resolvePeerShortLabel(peerId: string): string {
  const found = MESH_DEVICES.find((d) => d.peerId === peerId);
  return found ? found.shortLabel : peerId;
}

export class HolooPeerMeshManager {
  private peer: Peer | null = null;
  private connections = new Map<MeshDevicePeerId, DataConnection>();
  private peerStates = new Map<MeshDevicePeerId, MeshPeerRuntimeState>();
  private peerLastAckedHash = new Map<MeshDevicePeerId, string>();
  private peerLastHelloSent = new Map<MeshDevicePeerId, { hash: string; sentAt: number }>();
  private peerLastStateSent = new Map<MeshDevicePeerId, { hash: string; sentAt: number }>();
  private myPeerId: MeshDevicePeerId;
  private passphrase: string;
  private authTag: string;
  private replayGuard = new MeshReplayGuard();
  private callbacks: MeshSyncCallbacks;
  private batchConfig: MeshBatchConfig;
  private batcher: MeshUpdateBatcher;
  private lastFlushedBatchOpIds: string[] = [];
  private selfOnline = false;
  private selfError: string | null = null;
  private destroyed = false;
  private reconnectTimer: number | null = null;

  constructor(
    myPeerId: MeshDevicePeerId,
    passphrase: string,
    callbacks: MeshSyncCallbacks,
    batchConfig?: Partial<MeshBatchConfig>
  ) {
    this.myPeerId = myPeerId;
    this.passphrase = passphrase.trim();
    this.authTag = computeMeshAuthTag(this.passphrase);
    this.callbacks = callbacks;
    this.batchConfig = { ...DEFAULT_MESH_BATCH_CONFIG, ...(batchConfig || {}) };
    this.batcher = new MeshUpdateBatcher((batch) => {
      void this.announceBatchedVectorToPeers(batch);
    }, this.batchConfig);

    for (const dev of MESH_DEVICES) {
      if (dev.peerId === myPeerId) continue;
      this.peerStates.set(dev.peerId, {
        ...dev,
        status: 'offline',
        lastSeenAt: null,
        lastSyncedAt: null,
        lastError: null,
      });
    }
  }

  public start(): void {
    if (this.destroyed || typeof window === 'undefined') return;
    if (this.peer && !this.peer.destroyed) return;

    this.selfError = null;
    try {
      const peer = new Peer(this.myPeerId, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
          ],
        },
      });

      this.peer = peer;

      peer.on('open', () => {
        if (this.destroyed) return;
        this.selfOnline = true;
        this.selfError = null;
        this.emitStatus();
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'connection_open',
          status: 'success',
          direction: 'local',
          summary: `گره P2P دستگاه «${resolvePeerShortLabel(this.myPeerId)}» به شبکه سیگنالینگ متصل شد؛ آغاز اتصال خودکار به ۲ دستگاه دیگر.`,
        });
        // Automatic "On-Open" P2P connect to the other 2 devices
        this.connectToAllPeers();
      });

      peer.on('connection', (conn) => {
        if (this.destroyed) {
          conn.close();
          return;
        }
        const remoteId = conn.peer;
        if (!isValidMeshPeerId(remoteId) || remoteId === this.myPeerId) {
          this.emitSyncEvent({
            peerId: remoteId || 'unknown',
            eventType: 'auth_rejected',
            status: 'failed',
            direction: 'inbound',
            summary: `اتصال ورودی از شناسه غیرمجاز «${remoteId || 'ناشناس'}» مسدود شد.`,
            errorDetail: 'شناسه در فهرست ۳ دستگاه مجاز شبکه نیست.',
          });
          conn.close();
          return;
        }
        this.attachConnection(remoteId, conn);
      });

      peer.on('disconnected', () => {
        if (this.destroyed) return;
        this.selfOnline = false;
        this.emitStatus();
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'connection_close',
          status: 'info',
          direction: 'local',
          summary: 'ارتباط با سرور سیگنالینگ PeerJS قطع شد؛ تلاش مجدد خودکار زمان‌بندی گردید.',
        });
        this.scheduleReconnect();
      });

      peer.on('error', (err) => {
        if (this.destroyed) return;
        const errType = (err as { type?: string; message?: string })?.type || 'unknown';
        const errMsg = (err as { message?: string })?.message || '';
        if (errType === 'peer-unavailable') {
          // Normal when one of the other 2 devices is currently asleep/offline
          const targetMatch = errMsg.match(/holoo-mesh-[a-z0-9-]+/i);
          const targetPeer = targetMatch ? targetMatch[0] : 'peer';
          this.emitSyncEvent({
            peerId: targetPeer,
            eventType: 'peer_error',
            status: 'failed',
            direction: 'outbound',
            summary: `دستگاه همتا «${resolvePeerShortLabel(targetPeer)}» در حال حاضر آفلاین یا خاموش است؛ تغییرات در صف sync_outbox برای تحویل بعدی (Mesh Relay) نگهداری می‌شوند.`,
            errorDetail: 'peer-unavailable',
          });
          return;
        }
        if (errType === 'unavailable-id') {
          this.selfError = 'این شناسه دستگاه در تب دیگری باز است.';
        } else if (errType === 'network' || errType === 'server-error' || errType === 'socket-error') {
          this.selfOnline = false;
          this.selfError = 'در انتظار اتصال سیگنالینگ P2P (دستگاه آفلاین است یا اینترنت محدود است).';
          this.scheduleReconnect();
        } else {
          this.selfError = `خطای P2P (${errType})`;
        }
        this.emitSyncEvent({
          peerId: this.myPeerId,
          eventType: 'peer_error',
          status: 'failed',
          direction: 'local',
          summary: this.selfError || `خطای شبکه PeerJS (${errType})`,
          errorDetail: errMsg || errType,
        });
        this.emitStatus();
      });
    } catch (err) {
      this.selfOnline = false;
      this.selfError = 'راه‌اندازی WebRTC P2P در این مرورگر ممکن نشد.';
      this.emitSyncEvent({
        peerId: this.myPeerId,
        eventType: 'peer_error',
        status: 'failed',
        direction: 'local',
        summary: this.selfError,
        errorDetail: err instanceof Error ? err.message : 'WebRTC init error',
      });
      this.emitStatus();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || !navigator.onLine) return;
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this.restart();
        }
      } else if (!this.peer || this.peer.destroyed) {
        this.start();
      }
    }, 8000);
  }

  public restart(): void {
    this.stop(false);
    this.destroyed = false;
    this.start();
  }

  public connectToAllPeers(): void {
    if (this.destroyed || !this.peer || this.peer.destroyed || !this.selfOnline) return;
    for (const targetPeerId of getOtherMeshPeerIds(this.myPeerId)) {
      const existing = this.connections.get(targetPeerId);
      if (existing && existing.open) {
        void this.sendHello(existing);
        continue;
      }
      this.updatePeerState(targetPeerId, { status: 'connecting', lastError: null });
      try {
        const conn = this.peer.connect(targetPeerId, {
          reliable: true,
          serialization: 'json',
        });
        this.attachConnection(targetPeerId, conn);
      } catch {
        this.updatePeerState(targetPeerId, { status: 'offline' });
      }
    }
  }

  /**
   * Queues a small local transaction update into the adaptive batcher so rapid bursts
   * coalesce into a single lightweight version-vector (`mesh:hello`) exchange.
   */
  public queueLocalUpdate(operationId?: string): void {
    if (this.destroyed) return;
    this.batcher.enqueue(operationId);
  }

  /**
   * Immediately flushes any buffered transaction updates.
   * When `forceFullBroadcast` is false, sends only a lightweight coalesced version-vector (`mesh:hello`)
   * so peers pull full state only if they are actually behind.
   */
  public async flushBatchedUpdates(forceFullBroadcast = false): Promise<number> {
    if (this.destroyed) return 0;
    const flushed = this.batcher.flushNow();
    if (forceFullBroadcast) {
      return this.broadcastStateToConnectedPeers();
    }
    if (flushed) {
      return this.getConnectedPeerCount();
    }
    return this.announceBatchedVectorToPeers({ batchedCount: 1, operationIds: [] });
  }

  private getConnectedPeerCount(): number {
    let count = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.open) count += 1;
    }
    return count;
  }

  private async announceBatchedVectorToPeers(batch: BatchedUpdateFlushPayload): Promise<number> {
    if (this.destroyed) return 0;
    if (batch.operationIds.length > 0) {
      this.lastFlushedBatchOpIds = Array.from(
        new Set([...this.lastFlushedBatchOpIds, ...batch.operationIds])
      ).slice(-40);
    }

    const local = this.callbacks.getLocalSnapshot();
    const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    let notified = 0;

    for (const [remotePeerId, conn] of this.connections.entries()) {
      if (!conn.open) continue;
      const compactedRelays = compactRelayEnvelopesForPeer(
        pendingRelays,
        remotePeerId,
        local.payloadHash
      );
      const alreadyAcked =
        this.peerLastAckedHash.get(remotePeerId) === local.payloadHash &&
        compactedRelays.length === 0;
      if (alreadyAcked) continue;

      const sent = await this.sendHello(conn, {
        batchedCount: batch.batchedCount,
        force: batch.batchedCount > 1,
      });
      if (sent) notified += 1;
    }

    if (notified > 0 && batch.batchedCount > 1) {
      this.emitSyncEvent({
        peerId: this.myPeerId,
        eventType: 'vector_hello',
        status: 'success',
        direction: 'outbound',
        summary: `${batch.batchedCount} تغییر کوچک در ۱ تبادل بردار نسخه تجمیع (Batch) و به ${notified} همتا ارسال شد.`,
      });
    }

    return notified;
  }

  public async broadcastStateToConnectedPeers(): Promise<number> {
    if (this.destroyed) return 0;
    this.batcher.clear();
    let sent = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.open) {
        const pushed = await this.sendFullState(conn, true);
        if (pushed) sent += 1;
      }
    }
    return sent;
  }

  private attachConnection(remotePeerId: MeshDevicePeerId, conn: DataConnection): void {
    const prev = this.connections.get(remotePeerId);
    if (prev && prev !== conn && prev.open) {
      prev.close();
    }
    this.connections.set(remotePeerId, conn);

    conn.on('open', () => {
      if (this.destroyed) return;
      this.updatePeerState(remotePeerId, {
        status: 'connected',
        lastSeenAt: new Date().toISOString(),
        lastError: null,
      });
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'connection_open',
        status: 'success',
        direction: 'outbound',
        summary: `کانال مستقیم WebRTC با «${resolvePeerShortLabel(remotePeerId)}» برقرار شد؛ تبادل بردار نسخه آغاز گردید.`,
      });
      void this.sendHello(conn);
    });

    conn.on('data', (raw) => {
      if (this.destroyed) return;
      void this.handleMessage(remotePeerId, conn, raw);
    });

    conn.on('close', () => {
      if (this.connections.get(remotePeerId) === conn) {
        this.connections.delete(remotePeerId);
        this.updatePeerState(remotePeerId, { status: 'offline' });
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'connection_close',
          status: 'info',
          direction: 'local',
          summary: `اتصال مستقیم P2P با «${resolvePeerShortLabel(remotePeerId)}» بسته شد.`,
        });
      }
    });

    conn.on('error', (err) => {
      if (this.connections.get(remotePeerId) === conn) {
        this.connections.delete(remotePeerId);
        this.updatePeerState(remotePeerId, {
          status: 'offline',
          lastError: 'دستگاه همتا در دسترس نیست',
        });
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'peer_error',
          status: 'failed',
          direction: 'outbound',
          summary: `خطا در کانال ارتباطی با «${resolvePeerShortLabel(remotePeerId)}».`,
          errorDetail: err instanceof Error ? err.message : 'DataConnection error',
        });
      }
    });
  }

  private async sendHello(
    conn: DataConnection,
    opts?: { batchedCount?: number; force?: boolean }
  ): Promise<boolean> {
    if (!conn.open) return false;
    const remotePeerId = conn.peer as MeshDevicePeerId;
    const local = this.callbacks.getLocalSnapshot();
    const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    const relaysForPeer = compactRelayEnvelopesForPeer(
      pendingRelays,
      remotePeerId,
      local.payloadHash
    );

    const nowMs = Date.now();
    const prevHello = this.peerLastHelloSent.get(remotePeerId);
    if (
      !opts?.force &&
      prevHello &&
      prevHello.hash === local.payloadHash &&
      relaysForPeer.length === 0 &&
      nowMs - prevHello.sentAt < this.batchConfig.helloMinIntervalMs
    ) {
      return false;
    }

    const msg = await signMeshMessageEnvelopeSecure(this.passphrase, {
      type: 'mesh:hello',
      fromPeerId: this.myPeerId,
      authTag: this.authTag,
      updatedAt: local.updatedAt,
      payloadHash: local.payloadHash,
      vectorClock: local.vectorClock,
      pendingRelayIds: relaysForPeer.map((r) => r.operationId),
      batchedCount: opts?.batchedCount && opts.batchedCount > 1 ? opts.batchedCount : undefined,
    });
    try {
      conn.send(msg);
      this.peerLastHelloSent.set(remotePeerId, { hash: local.payloadHash, sentAt: nowMs });
      return true;
    } catch (err) {
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: 'vector_hello',
        status: 'failed',
        direction: 'outbound',
        summary: `ارسال بردار نسخه به «${resolvePeerShortLabel(conn.peer)}» ناموفق بود.`,
        errorDetail: err instanceof Error ? err.message : 'send failed',
      });
      return false;
    }
  }

  private async sendFullState(conn: DataConnection, force = false): Promise<boolean> {
    if (!conn.open) return false;
    const remotePeerId = conn.peer as MeshDevicePeerId;
    const local = this.callbacks.getLocalSnapshot();
    const allPendingRelays = await this.callbacks.getPendingRelayEnvelopes();
    const relayEnvelopes = compactRelayEnvelopesForPeer(
      allPendingRelays,
      remotePeerId,
      local.payloadHash
    );

    const nowMs = Date.now();
    const prevSent = this.peerLastStateSent.get(remotePeerId);
    if (
      !force &&
      prevSent &&
      prevSent.hash === local.payloadHash &&
      relayEnvelopes.length === 0 &&
      nowMs - prevSent.sentAt < this.batchConfig.helloMinIntervalMs
    ) {
      return false;
    }

    const batchedOpIds = Array.from(
      new Set([
        ...this.lastFlushedBatchOpIds,
        ...relayEnvelopes.map((r) => r.operationId),
      ])
    );

    const wireSnapshotJson = await encryptMeshPayloadAesGcm(this.passphrase, local.snapshotJson);
    const msg = await signMeshMessageEnvelopeSecure(this.passphrase, {
      type: 'mesh:state_payload',
      fromPeerId: this.myPeerId,
      authTag: this.authTag,
      updatedAt: local.updatedAt,
      payloadHash: local.payloadHash,
      vectorClock: local.vectorClock,
      snapshotJson: wireSnapshotJson,
      relayEnvelopes,
      batchedOperationIds: batchedOpIds.length > 0 ? batchedOpIds : undefined,
    });
    try {
      conn.send(msg);
      this.peerLastStateSent.set(remotePeerId, { hash: local.payloadHash, sentAt: nowMs });
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: relayEnvelopes.length > 0 ? 'relay_forwarded' : 'state_push',
        status: 'success',
        direction: 'outbound',
        summary:
          relayEnvelopes.length > 0
            ? `بسته وضعیت بهینه‌شده + ${relayEnvelopes.length} عملیات رله صف (Mesh Relay) به «${resolvePeerShortLabel(conn.peer)}» ارسال شد.`
            : `بسته وضعیت پایگاه داده (${batchedOpIds.length > 1 ? `${batchedOpIds.length} تغییر تجمیع‌شده` : 'نسخه جدید'}) به «${resolvePeerShortLabel(conn.peer)}» ارسال شد.`,
      });
      return true;
    } catch (err) {
      this.emitSyncEvent({
        peerId: conn.peer,
        eventType: 'state_push',
        status: 'failed',
        direction: 'outbound',
        summary: `ارسال بسته وضعیت به «${resolvePeerShortLabel(conn.peer)}» با خطا متوقف شد.`,
        errorDetail: err instanceof Error ? err.message : 'send state failed',
      });
      return false;
    }
  }

  private async handleMessage(
    remotePeerId: MeshDevicePeerId,
    conn: DataConnection,
    raw: unknown
  ): Promise<void> {
    if (!raw || typeof raw !== 'object') return;

    // Strict cryptographic envelope check: allowlist + passphrase + 256-bit MAC + ±5m window + nonce replay guard + size cap
    const verification = await verifyMeshMessageEnvelopeSecure({
      passphrase: this.passphrase,
      expectedPeerId: remotePeerId,
      raw,
      replayGuard: this.replayGuard,
    });

    if (!verification.ok) {
      const errorLabel =
        verification.reason === 'replay_detected'
          ? 'بسته تکراری (Replay) مسدود شد'
          : verification.reason === 'timestamp_out_of_window'
            ? 'اختلاف ساعت دستگاه بیش از ۵ دقیقه است'
            : verification.reason === 'mac_mismatch'
              ? 'امضای دیجیتال پیام نامعتبر یا دستکاری‌شده است'
              : verification.reason === 'payload_too_large'
                ? 'حجم بسته دریافتی بیش از حد مجاز امنیتی است'
                : 'کلید امنیتی شبکه ۳ دستگاه مطابقت ندارد';
      this.updatePeerState(remotePeerId, {
        status: 'error',
        lastError: errorLabel,
      });
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'auth_rejected',
        status: 'failed',
        direction: 'inbound',
        summary: `بسته ورودی از «${resolvePeerShortLabel(remotePeerId)}» به دلیل «${errorLabel}» مسدود شد.`,
        errorDetail: `${verification.reason}: ${verification.detail}`,
      });
      conn.close();
      return;
    }

    const msg = raw as MeshWireMessage;

    const nowIso = new Date().toISOString();
    this.updatePeerState(remotePeerId, { status: 'connected', lastSeenAt: nowIso, lastError: null });

    if (msg.type === 'mesh:hello') {
      const local = this.callbacks.getLocalSnapshot();
      const pendingRelays = await this.callbacks.getPendingRelayEnvelopes();
      const localRelaysForRemote = compactRelayEnvelopesForPeer(
        pendingRelays,
        remotePeerId,
        local.payloadHash
      );

      const decision = evaluateVectorExchangeDecision({
        localClock: local.vectorClock,
        remoteClock: msg.vectorClock || {},
        localHash: local.payloadHash,
        remoteHash: msg.payloadHash,
        localPeerId: this.myPeerId,
        remotePeerId,
        remotePendingRelayIds: Array.isArray(msg.pendingRelayIds) ? msg.pendingRelayIds : [],
        localPendingRelayCountForRemote: localRelaysForRemote.length,
      });

      const batchNote =
        msg.batchedCount && msg.batchedCount > 1
          ? ` (تجمیع ${msg.batchedCount} تغییر)`
          : '';

      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'vector_hello',
        status: 'success',
        direction: 'inbound',
        remoteVectorClock: msg.vectorClock || {},
        summary: decision.inSync
          ? `تبادل بردار نسخه با «${resolvePeerShortLabel(remotePeerId)}»${batchNote} موفق بود — هر دو دستگاه کاملاً همگام هستند (بدون ارسال داده اضافی).`
          : `تبادل بردار نسخه با «${resolvePeerShortLabel(remotePeerId)}»${batchNote} انجام شد — تفاوت نسخه شناسایی و همگام‌سازی هدفمند آغاز گردید.`,
      });

      if (decision.inSync) {
        this.peerLastAckedHash.set(remotePeerId, local.payloadHash);
        this.updatePeerState(remotePeerId, { lastSyncedAt: nowIso });
        return;
      }

      if (decision.shouldRequestRemoteState && conn.open) {
        conn.send(
          await signMeshMessageEnvelopeSecure(this.passphrase, {
            type: 'mesh:request_state',
            fromPeerId: this.myPeerId,
            authTag: this.authTag,
          })
        );
      }

      if (decision.shouldSendLocalState) {
        await this.sendFullState(conn);
      }
      return;
    }

    if (msg.type === 'mesh:request_state') {
      await this.sendFullState(conn, true);
      return;
    }

    if (msg.type === 'mesh:state_payload') {
      try {
        const plainSnapshotJson = await decryptMeshPayloadAesGcm(this.passphrase, msg.snapshotJson);
        const receivedOpIds = await this.callbacks.onRemoteStateReceived({
          fromPeerId: remotePeerId,
          snapshotJson: plainSnapshotJson,
          payloadHash: msg.payloadHash,
          vectorClock: msg.vectorClock || {},
          relayEnvelopes: Array.isArray(msg.relayEnvelopes) ? msg.relayEnvelopes : [],
          batchedOperationIds: Array.isArray(msg.batchedOperationIds)
            ? msg.batchedOperationIds
            : undefined,
        });
        this.peerLastAckedHash.set(remotePeerId, msg.payloadHash);
        this.updatePeerState(remotePeerId, { lastSyncedAt: nowIso });
        if (conn.open) {
          conn.send(
            await signMeshMessageEnvelopeSecure(this.passphrase, {
              type: 'mesh:ack',
              fromPeerId: this.myPeerId,
              authTag: this.authTag,
              receivedOperationIds: receivedOpIds,
              payloadHash: msg.payloadHash,
              syncedAt: nowIso,
            })
          );
        }
      } catch (err) {
        this.emitSyncEvent({
          peerId: remotePeerId,
          eventType: 'state_pull',
          status: 'failed',
          direction: 'inbound',
          remoteVectorClock: msg.vectorClock || {},
          summary: `ادغام بسته دریافتی از «${resolvePeerShortLabel(remotePeerId)}» با خطا مواجه شد.`,
          errorDetail: err instanceof Error ? err.message : 'merge failed',
        });
      }
      return;
    }

    if (msg.type === 'mesh:ack') {
      if (msg.payloadHash) {
        this.peerLastAckedHash.set(remotePeerId, msg.payloadHash);
      }
      this.updatePeerState(remotePeerId, { lastSyncedAt: msg.syncedAt || nowIso });
      const opIds = Array.isArray(msg.receivedOperationIds) ? msg.receivedOperationIds : [];
      if (opIds.length > 0) {
        const ackedSet = new Set(opIds);
        this.lastFlushedBatchOpIds = this.lastFlushedBatchOpIds.filter((id) => !ackedSet.has(id));
      }
      this.emitSyncEvent({
        peerId: remotePeerId,
        eventType: 'ack_received',
        status: 'success',
        direction: 'inbound',
        summary: `تایید تحویل (ACK) از «${resolvePeerShortLabel(remotePeerId)}» دریافت شد (${opIds.length} عملیات صف تسویه گردید).`,
      });
      await this.callbacks.onPeerAckReceived({
        fromPeerId: remotePeerId,
        receivedOperationIds: opIds,
        syncedAt: msg.syncedAt || nowIso,
      });
    }
  }

  private emitSyncEvent(
    partial: Omit<MeshSyncEventLog, 'id' | 'eventId' | 'timestamp' | 'peerLabel' | 'localVectorClock'> & {
      localVectorClock?: Record<string, number>;
    }
  ): void {
    if (!this.callbacks.onSyncEvent) return;
    const localClock = partial.localVectorClock || this.callbacks.getLocalSnapshot().vectorClock;
    this.callbacks.onSyncEvent({
      eventId: `mevt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      peerLabel: resolvePeerShortLabel(partial.peerId),
      localVectorClock: { ...localClock },
      ...partial,
    });
  }

  private updatePeerState(peerId: MeshDevicePeerId, patch: Partial<MeshPeerRuntimeState>): void {
    const existing = this.peerStates.get(peerId);
    if (!existing) return;
    this.peerStates.set(peerId, { ...existing, ...patch });
    this.emitStatus();
  }

  private emitStatus(): void {
    this.callbacks.onStatusChange(
      Array.from(this.peerStates.values()),
      this.selfOnline,
      this.selfError
    );
  }

  public getPeerStates(): MeshPeerRuntimeState[] {
    return Array.from(this.peerStates.values());
  }

  public stop(markDestroyed = true): void {
    if (markDestroyed) {
      this.destroyed = true;
      this.batcher.dispose();
    } else {
      this.batcher.clear();
    }
    this.peerLastAckedHash.clear();
    this.peerLastHelloSent.clear();
    this.peerLastStateSent.clear();
    this.replayGuard.clear();
    this.lastFlushedBatchOpIds = [];
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, conn] of this.connections.entries()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }
    this.selfOnline = false;
  }
}

/** Named alias fulfilling the explicit PeerMeshConnector module specification */
export class PeerMeshConnector extends HolooPeerMeshManager {}

export function buildRelayEnvelopesFromOutbox(
  items: MeshSyncOutboxItem[],
  currentSnapshotJson: string
): MeshRelayEnvelope[] {
  return items
    .filter((item) => item.target === 'p2p_mesh' && item.status !== 'synced')
    .slice(0, 15)
    .map((item) => ({
      operationId: item.operationId,
      originDeviceId: item.originDeviceId,
      payloadHash: item.payloadHash,
      snapshotJson: item.snapshotJson || currentSnapshotJson,
      deliveredToPeers: item.deliveredToPeers || [],
      requiredPeers: item.requiredPeers || [],
      createdAt: item.createdAt,
      summary: item.summary,
    }));
}
