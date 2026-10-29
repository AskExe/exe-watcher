/**
 * @odd/crypto - Key Management Module
 *
 * Implements:
 * - X25519 key exchange (ECDH)
 * - Argon2id key derivation (v2 - current)
 * - scrypt key derivation (v1 - legacy for existing journal app data)
 * - HMAC-SHA256 for authentication
 *
 * Target Stack (Signal Protocol):
 * - Key Exchange: X25519
 * - Key Derivation: Argon2id
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { argon2id } from '@noble/hashes/argon2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

// =============================================================================
// Types
// =============================================================================

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface DerivedKey {
  key: Uint8Array;
  salt: Uint8Array;
  version: 1 | 2;
}

// =============================================================================
// Constants
// =============================================================================

const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits (generated salt size)
const MIN_SALT_LENGTH = 16; // 128 bits (NIST SP 800-132 minimum for provided salts)

// Argon2id parameters (OWASP recommended)
const ARGON2_ITERATIONS = 3;
const ARGON2_MEMORY = 65536; // 64 MB
const ARGON2_PARALLELISM = 4;

// scrypt parameters (legacy)
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8; // Block size
const SCRYPT_P = 1; // Parallelism

// Rate limiting for expensive operations
const KDF_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const KDF_RATE_LIMIT_MAX_OPS = 10; // Max 10 KDF operations per window

// =============================================================================
// Rate Limiting
// =============================================================================

interface RateLimitState {
  timestamps: number[];
  windowMs: number;
  maxOps: number;
}

const kdfRateLimiter: RateLimitState = {
  timestamps: [],
  windowMs: KDF_RATE_LIMIT_WINDOW_MS,
  maxOps: KDF_RATE_LIMIT_MAX_OPS,
};

/**
 * Check if an operation is rate limited
 * @param limiter - Rate limit state to check
 * @returns true if allowed, false if rate limited
 */
function checkRateLimit(limiter: RateLimitState): boolean {
  const now = Date.now();
  const windowStart = now - limiter.windowMs;

  // Remove timestamps outside the window
  limiter.timestamps = limiter.timestamps.filter((t) => t > windowStart);

  // Check if under the limit
  if (limiter.timestamps.length >= limiter.maxOps) {
    return false;
  }

  // Record this operation
  limiter.timestamps.push(now);
  return true;
}

/**
 * Reset rate limiter (for testing)
 */
export function resetKdfRateLimit(): void {
  kdfRateLimiter.timestamps = [];
}

/**
 * Configure KDF rate limit (for testing or special cases)
 * @param maxOps - Maximum operations per window
 * @param windowMs - Window duration in milliseconds
 */
export function configureKdfRateLimit(maxOps: number, windowMs: number): void {
  if (maxOps < 1 || maxOps > 1000) {
    throw new Error('maxOps must be between 1 and 1000');
  }
  if (windowMs < 1000 || windowMs > 3600000) {
    throw new Error('windowMs must be between 1 second and 1 hour');
  }
  kdfRateLimiter.maxOps = maxOps;
  kdfRateLimiter.windowMs = windowMs;
  kdfRateLimiter.timestamps = [];
}

export class KdfRateLimitError extends Error {
  constructor() {
    super(
      'Key derivation rate limit exceeded. Please wait before trying again.'
    );
    this.name = 'KdfRateLimitError';
  }
}

export class InvalidSaltError extends Error {
  constructor(providedLength: number) {
    super(
      `Salt must be at least ${MIN_SALT_LENGTH} bytes (${MIN_SALT_LENGTH * 8} bits). ` +
      `Provided: ${providedLength} bytes.`
    );
    this.name = 'InvalidSaltError';
  }
}

// =============================================================================
// X25519 Key Exchange
// =============================================================================

/**
 * Generate a new X25519 key pair for ECDH key exchange
 */
export function generateKeyPair(): KeyPair {
  const privateKey = randomBytes(32);
  const publicKey = x25519.getPublicKey(privateKey);

  return {
    publicKey,
    privateKey,
  };
}

/**
 * Derive a shared secret from your private key and their public key
 * @param privateKey - Your private key
 * @param publicKey - Their public key
 * @returns 32-byte shared secret
 */
export function deriveSharedSecret(
  privateKey: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

// =============================================================================
// V2: Argon2id Key Derivation (Current Standard)
// =============================================================================

/**
 * Derive a key from a password using Argon2id
 * @param password - User's password or passphrase
 * @param salt - Optional salt (generated if not provided; must be at least 16 bytes if provided)
 * @param skipRateLimit - Skip rate limiting (internal use only)
 * @throws {KdfRateLimitError} If rate limit is exceeded
 * @throws {InvalidSaltError} If provided salt is too short
 */
export async function deriveKeyV2(
  password: string,
  salt?: Uint8Array,
  skipRateLimit: boolean = false
): Promise<DerivedKey> {
  // Validate salt size if provided
  if (salt !== undefined && salt.length < MIN_SALT_LENGTH) {
    throw new InvalidSaltError(salt.length);
  }

  // Check rate limit for expensive KDF operations
  if (!skipRateLimit && !checkRateLimit(kdfRateLimiter)) {
    throw new KdfRateLimitError();
  }

  const actualSalt = salt || randomBytes(SALT_LENGTH);
  const encoder = new TextEncoder();

  const key = argon2id(encoder.encode(password), actualSalt, {
    t: ARGON2_ITERATIONS,
    m: ARGON2_MEMORY,
    p: ARGON2_PARALLELISM,
    dkLen: KEY_LENGTH,
  });

  return {
    key,
    salt: actualSalt,
    version: 2,
  };
}

// =============================================================================
// V1: scrypt Key Derivation (Legacy)
// =============================================================================

/**
 * Derive a key from a password using scrypt (legacy)
 * @deprecated Use deriveKeyV2 for new key derivations
 * @param password - User's password or passphrase
 * @param salt - Optional salt (generated if not provided; must be at least 16 bytes if provided)
 * @param skipRateLimit - Skip rate limiting (internal use only)
 * @throws {KdfRateLimitError} If rate limit is exceeded
 * @throws {InvalidSaltError} If provided salt is too short
 */
export async function deriveKeyV1(
  password: string,
  salt?: Uint8Array,
  skipRateLimit: boolean = false
): Promise<DerivedKey> {
  // Validate salt size if provided
  if (salt !== undefined && salt.length < MIN_SALT_LENGTH) {
    throw new InvalidSaltError(salt.length);
  }

  // Check rate limit for expensive KDF operations
  if (!skipRateLimit && !checkRateLimit(kdfRateLimiter)) {
    throw new KdfRateLimitError();
  }

  const actualSalt = salt || randomBytes(SALT_LENGTH);
  const encoder = new TextEncoder();

  const key = scrypt(encoder.encode(password), actualSalt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: KEY_LENGTH,
  });

  return {
    key,
    salt: actualSalt,
    version: 1,
  };
}

// =============================================================================
// Public API (Version-Aware)
// =============================================================================

/**
 * Derive a key from a password - always uses current version (Argon2id)
 * @param password - User's password or passphrase
 * @param salt - Optional salt (generated if not provided)
 */
export async function deriveKey(
  password: string,
  salt?: Uint8Array
): Promise<DerivedKey> {
  return deriveKeyV2(password, salt);
}

/**
 * Derive a key using a specific version (for decrypting old data)
 * @param password - User's password or passphrase
 * @param salt - Salt used during original derivation
 * @param version - Which KDF version to use
 */
export async function deriveKeyWithVersion(
  password: string,
  salt: Uint8Array,
  version: 1 | 2
): Promise<DerivedKey> {
  switch (version) {
    case 1:
      return deriveKeyV1(password, salt);
    case 2:
      return deriveKeyV2(password, salt);
    default:
      throw new Error(`Unknown KDF version: ${version}`);
  }
}

// =============================================================================
// HMAC-SHA256
// =============================================================================

/**
 * Generate HMAC-SHA256 for message authentication
 * @param key - Secret key
 * @param message - Message to authenticate
 */
export function hmacSign(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

// Alias for backward compatibility
export const generateHmac = hmacSign;

/**
 * Verify HMAC-SHA256 using constant-time comparison
 * @param key - Secret key
 * @param message - Message that was authenticated
 * @param mac - MAC to verify against
 */
export function hmacVerify(
  key: Uint8Array,
  message: Uint8Array,
  mac: Uint8Array
): boolean {
  const expected = hmacSign(key, message);

  // Constant-time comparison to prevent timing attacks
  // Always compare all bytes even if lengths differ
  const maxLen = Math.max(expected.length, mac.length);
  let result = expected.length ^ mac.length; // Will be non-zero if lengths differ

  for (let i = 0; i < maxLen; i++) {
    const a = i < expected.length ? expected[i]! : 0;
    const b = i < mac.length ? mac[i]! : 0;
    result |= a ^ b;
  }

  return result === 0;
}

// Alias for backward compatibility
export const verifyHmac = hmacVerify;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate cryptographically secure random bytes
 * @param length - Number of bytes to generate
 */
export function generateRandomBytes(length: number): Uint8Array {
  if (length <= 0 || length > 1024 * 1024) {
    throw new Error('Invalid length: must be between 1 and 1MB');
  }
  return randomBytes(length);
}

/**
 * Generate a random 256-bit key
 */
export function generateRandomKey(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

/**
 * Securely zero out sensitive key material
 * Call this after you're done using a key to minimize exposure in memory
 * @param arr - Uint8Array to zero out
 */
export function secureZero(arr: Uint8Array): void {
  arr.fill(0);
}

/**
 * Securely zero multiple arrays
 * @param arrays - Arrays to zero out
 */
export function secureZeroAll(...arrays: Uint8Array[]): void {
  for (const arr of arrays) {
    if (arr) {
      arr.fill(0);
    }
  }
}
