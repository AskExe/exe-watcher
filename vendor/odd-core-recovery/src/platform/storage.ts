/**
 * @odd/crypto - Secure Storage Module
 *
 * Platform-aware secure storage for encryption keys.
 * This file provides the interface - platform-specific implementations
 * are in storage.electron.ts and storage.mobile.ts
 *
 * Storage Backends:
 * - Electron: electron-store (encrypted at rest)
 * - Mobile (Expo): expo-secure-store (Keychain/Keystore)
 */

// =============================================================================
// Types
// =============================================================================

export interface StoredKey {
  /** The encryption key (base64 encoded) */
  key: string;
  /** Key version for rotation tracking */
  version: number;
  /** When this key was stored */
  storedAt: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface KeyStorage {
  /** Store a key for a space */
  storeKey(spaceId: string, key: Uint8Array, version: number): Promise<void>;

  /** Retrieve a key for a space */
  retrieveKey(spaceId: string): Promise<Uint8Array | null>;

  /** Retrieve key with metadata */
  retrieveKeyWithMetadata(spaceId: string): Promise<StoredKey | null>;

  /** Delete a key for a space */
  deleteKey(spaceId: string): Promise<void>;

  /** List all stored space IDs */
  listSpaces(): Promise<string[]>;

  /** Clear all stored keys */
  clearAll(): Promise<void>;
}

// =============================================================================
// Platform Detection
// =============================================================================

export function detectPlatform(): 'electron' | 'mobile' | 'web' | 'unknown' {
  // Electron detection
  if (
    typeof window !== 'undefined' &&
    typeof window.process === 'object' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.process as any).type === 'renderer'
  ) {
    return 'electron';
  }

  // React Native detection
  if (
    typeof navigator !== 'undefined' &&
    navigator.product === 'ReactNative'
  ) {
    return 'mobile';
  }

  // Web browser detection
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    return 'web';
  }

  return 'unknown';
}

// Alias for backward compatibility
export const getPlatform = detectPlatform;

// =============================================================================
// Storage Key Prefix
// =============================================================================

const KEY_PREFIX = '@odd/crypto/space/';

export function getStorageKey(spaceId: string): string {
  return `${KEY_PREFIX}${spaceId}`;
}

// =============================================================================
// Base64 Utilities (shared across platforms)
// =============================================================================

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
