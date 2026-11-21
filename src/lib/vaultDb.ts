import { DEFAULT_ROUTING_PROFILES } from '../../shared/providers.ts';
import type {
  EncryptedVaultEnvelope,
  KeyUsageStats,
  RouterLogEntry,
  VaultPayload,
} from '../../shared/types.ts';

const DB_NAME = 'relaygate-vault-db';
const DB_VERSION = 1;
const STORE_VAULT = 'vault';
const STORE_USAGE = 'usage';
const PBKDF2_ITERATIONS = 210_000;

export function createEmptyVault(): VaultPayload {
  return {
    version: 1,
    updatedAt: Date.now(),
    keys: [],
    customEndpoints: [],
    profiles: DEFAULT_ROUTING_PROFILES.map((p) => ({
      ...p,
      hops: p.hops.map((h) => ({ ...h })),
    })),
    defaultStrategy: 'auto',
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptVaultPayload(
  payload: VaultPayload,
  passphrase: string,
  hasPin: boolean
): Promise<EncryptedVaultEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    encoded
  );

  return {
    format: 'relaygate-vault-v1',
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    hasPin,
    updatedAt: payload.updatedAt || Date.now(),
  };
}

export async function decryptVaultPayload(
  envelope: EncryptedVaultEnvelope,
  passphrase: string
): Promise<VaultPayload> {
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const key = await deriveAesKey(
    passphrase,
    salt,
    envelope.iterations || PBKDF2_ITERATIONS
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  const text = new TextDecoder().decode(decrypted);
  const parsed = JSON.parse(text) as VaultPayload;
  if (!parsed || !Array.isArray(parsed.keys)) {
    throw new Error('Decrypted payload is not a valid RelayGate vault.');
  }
  return {
    version: 1,
    updatedAt: parsed.updatedAt || Date.now(),
    keys: parsed.keys,
    customEndpoints: Array.isArray(parsed.customEndpoints) ? parsed.customEndpoints : [],
    profiles:
      Array.isArray(parsed.profiles) && parsed.profiles.length > 0
        ? parsed.profiles
        : createEmptyVault().profiles,
    defaultStrategy: parsed.defaultStrategy || 'auto',
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VAULT)) {
        db.createObjectStore(STORE_VAULT, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_USAGE)) {
        db.createObjectStore(STORE_USAGE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
}

async function idbGet<T>(storeName: string, id: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(storeName: string, record: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateDeviceSecret(): Promise<string> {
  const rec = await idbGet<{ id: string; secret: string }>(STORE_VAULT, 'device_secret');
  if (rec?.secret) return rec.secret;
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = bytesToBase64(randomBytes);
  await idbPut(STORE_VAULT, { id: 'device_secret', secret });
  return secret;
}

export interface VaultInitResult {
  locked: boolean;
  hasPin: boolean;
  vault: VaultPayload | null;
  envelope: EncryptedVaultEnvelope | null;
}

export async function initializeVaultFromIndexedDb(): Promise<VaultInitResult> {
  const rec = await idbGet<{ id: string; envelope: EncryptedVaultEnvelope }>(
    STORE_VAULT,
    'primary'
  );

  if (!rec?.envelope) {
    const fresh = createEmptyVault();
    const deviceSecret = await getOrCreateDeviceSecret();
    const envelope = await encryptVaultPayload(fresh, deviceSecret, false);
    await idbPut(STORE_VAULT, { id: 'primary', envelope });
    return { locked: false, hasPin: false, vault: fresh, envelope };
  }

  if (rec.envelope.hasPin) {
    return { locked: true, hasPin: true, vault: null, envelope: rec.envelope };
  }

  const deviceSecret = await getOrCreateDeviceSecret();
  try {
    const vault = await decryptVaultPayload(rec.envelope, deviceSecret);
    return { locked: false, hasPin: false, vault, envelope: rec.envelope };
  } catch {
    const fresh = createEmptyVault();
    const envelope = await encryptVaultPayload(fresh, deviceSecret, false);
    await idbPut(STORE_VAULT, { id: 'primary', envelope });
    return { locked: false, hasPin: false, vault: fresh, envelope };
  }
}

export async function unlockVaultWithPin(pin: string): Promise<VaultPayload> {
  const rec = await idbGet<{ id: string; envelope: EncryptedVaultEnvelope }>(
    STORE_VAULT,
    'primary'
  );
  if (!rec?.envelope) {
    throw new Error('No encrypted vault found in IndexedDB.');
  }
  return decryptVaultPayload(rec.envelope, pin);
}

export async function persistVaultToIndexedDb(
  payload: VaultPayload,
  activePin: string | null
): Promise<EncryptedVaultEnvelope> {
  const stamped: VaultPayload = { ...payload, updatedAt: Date.now() };
  const secret = activePin ? activePin : await getOrCreateDeviceSecret();
  const envelope = await encryptVaultPayload(stamped, secret, Boolean(activePin));
  await idbPut(STORE_VAULT, { id: 'primary', envelope });
  return envelope;
}

export async function importVaultBackupJson(
  rawJson: string,
  passphrase?: string
): Promise<VaultPayload> {
  const parsed = JSON.parse(rawJson);
  if (parsed?.format === 'relaygate-vault-v1') {
    if (!passphrase) {
      throw new Error('This backup is encrypted. Enter the backup passphrase or PIN to decrypt.');
    }
    return decryptVaultPayload(parsed as EncryptedVaultEnvelope, passphrase);
  }
  if (parsed && Array.isArray(parsed.keys)) {
    return {
      version: 1,
      updatedAt: Date.now(),
      keys: parsed.keys,
      customEndpoints: Array.isArray(parsed.customEndpoints) ? parsed.customEndpoints : [],
      profiles:
        Array.isArray(parsed.profiles) && parsed.profiles.length > 0
          ? parsed.profiles
          : createEmptyVault().profiles,
      defaultStrategy: parsed.defaultStrategy || 'auto',
    };
  }
  throw new Error('Unsupported backup file format.');
}

// Local IndexedDB Usage & Logs Archive
export interface StoredUsageArchive {
  id: 'metrics';
  keyStats: KeyUsageStats[];
  recentLogs: RouterLogEntry[];
  savedAt: number;
}

export async function saveUsageArchiveToIndexedDb(
  keyStats: KeyUsageStats[],
  recentLogs: RouterLogEntry[]
): Promise<void> {
  try {
    await idbPut<StoredUsageArchive>(STORE_USAGE, {
      id: 'metrics',
      keyStats,
      recentLogs: recentLogs.slice(0, 150),
      savedAt: Date.now(),
    });
  } catch {
    // Non-fatal if browser storage quota reached
  }
}

export async function loadUsageArchiveFromIndexedDb(): Promise<StoredUsageArchive | null> {
  try {
    const rec = await idbGet<StoredUsageArchive>(STORE_USAGE, 'metrics');
    return rec || null;
  } catch {
    return null;
  }
}
