/** Account recovery is opt-in. Persist only an app wrapping key, never the root/phrase. */
import * as bip39 from 'bip39';
import { gcm } from '@noble/ciphers/aes.js';
import { hmacSign, generateRandomBytes, secureZero } from './keys';
import { uint8ArrayToBase64, base64ToUint8Array } from '../platform/storage';

export interface RecoveryCiphertext { iv: string; ciphertext: string }
export interface OddRecoveryHeader {
  format: 'odd-account-recovery-v1'; accountId: string; vaultId: string; check: RecoveryCiphertext;
}
export interface OddAppKeyCapsule {
  format: 'odd-app-key-capsule-v1'; accountId: string; vaultId: string;
  appCode: string; revision: number; wrappedKey: RecoveryCiphertext;
}
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const app = /^[a-z][a-z0-9_-]{0,63}$/;
function fail(): never { throw new Error('Invalid account recovery data or authentication'); }
function key(value: Uint8Array): void { if (!(value instanceof Uint8Array) || value.length !== 32) fail(); }
function header(value: OddRecoveryHeader): void {
  if (!value || value.format !== 'odd-account-recovery-v1' || !uuid.test(value.accountId) || !uuid.test(value.vaultId)) fail();
}
function context(h: OddRecoveryHeader, label: string, appCode?: string, revision?: number): Uint8Array {
  header(h);
  if (appCode !== undefined && !app.test(appCode)) fail();
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) fail();
  return encoder.encode(JSON.stringify(['odd-account-recovery-v1', label, h.accountId, h.vaultId, appCode ?? null, revision ?? null]));
}
function decode(value: string, size: number): Uint8Array {
  if (typeof value !== 'string' || value.length > 22000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = base64ToUint8Array(value);
  if ((size === -1 ? bytes.length < 17 || bytes.length > 16400 : bytes.length !== size) || uint8ArrayToBase64(bytes) !== value) fail();
  return bytes;
}
/** Validate an untrusted remote header before any enrollment or local key binding. */
export function parseRecoveryHeader(value: unknown): OddRecoveryHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const h = value as OddRecoveryHeader;
  header(h);
  if (Object.keys(h).sort().join(',') !== 'accountId,check,format,vaultId' ||
      !h.check || typeof h.check !== 'object' || Array.isArray(h.check) ||
      Object.keys(h.check).sort().join(',') !== 'ciphertext,iv') fail();
  decode(h.check.iv, 12);
  decode(h.check.ciphertext, 34);
  return { format: h.format, accountId: h.accountId, vaultId: h.vaultId,
    check: { iv: h.check.iv, ciphertext: h.check.ciphertext } };
}
function seal(k: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): RecoveryCiphertext {
  key(k);
  const iv = generateRandomBytes(12);
  return { iv: uint8ArrayToBase64(iv), ciphertext: uint8ArrayToBase64(gcm(k, iv, aad).encrypt(plaintext)) };
}
function open(k: Uint8Array, aad: Uint8Array, envelope: RecoveryCiphertext, size: number): Uint8Array {
  key(k);
  try { return gcm(k, decode(envelope.iv, 12), aad).decrypt(decode(envelope.ciphertext, size === -1 ? -1 : size + 16)); }
  catch { return fail(); }
}
/** Shared generator: 32 bytes from the OS RNG, encoded as a 24-word English BIP39 phrase. */
export function createRecoveryPhrase(): string {
  const entropy = generateRandomBytes(32);
  try {
    return bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'), bip39.wordlists.english);
  } finally { secureZero(entropy); }
}
/** English BIP39 256-bit entropy; this format intentionally does not change legacy app KDFs. */
export function recoveryRootFromPhrase(phrase: string): Uint8Array {
  if (typeof phrase !== 'string') fail();
  const normalized = phrase.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  if (normalized.split(' ').length !== 24 || !bip39.validateMnemonic(normalized, bip39.wordlists.english)) fail();
  const hex = bip39.mnemonicToEntropy(normalized, bip39.wordlists.english);
  return Uint8Array.from(hex.match(/../g)!.map(v => parseInt(v, 16)));
}
/**
 * Published BIP39 English test-vector entropies (trezor/python-mnemonic `vectors.json`,
 * the 32-byte / 24-word entries), as lowercase hex. These mnemonics -- including the
 * all-zero "abandon ... art" phrase -- are printed in public BIP39 documentation and must
 * never be installed as a real recovery phrase. Four of the eight are also caught by the
 * all-equal-byte check below (0x00, 0x7f, 0x80, 0xff); kept explicit here so the published
 * list is self-documenting.
 */
const KNOWN_WEAK_RECOVERY_ENTROPY_HEX = new Set<string>([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
  '8080808080808080808080808080808080808080808080808080808080808080',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c',
  '9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863',
  '066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad',
  'f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f',
]);
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
/**
 * True when 32 bytes of recovery-phrase entropy is too weak to install as a NEW phrase:
 * every byte equal (covers 0x00..., 0xff..., 0x7f..., 0x80...), or one of the published
 * BIP39 English test-vector entropies above. `createRecoveryPhrase` draws from the OS
 * CSPRNG and will not practically produce either, so this only guards a caller-supplied or
 * typed phrase at the point a NEW phrase is installed (reset completion, rotation, first
 * enrollment). Do not apply this to unlocking/restoring with an EXISTING phrase.
 */
export function isWeakRecoveryEntropy(entropy: Uint8Array): boolean {
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) return false;
  if (entropy.every((b) => b === entropy[0])) return true;
  return KNOWN_WEAK_RECOVERY_ENTROPY_HEX.has(toHex(entropy));
}

export function createRecoveryHeader(root: Uint8Array, accountId: string, vaultId: string): OddRecoveryHeader {
  key(root);
  const h: OddRecoveryHeader = { format: 'odd-account-recovery-v1', accountId, vaultId, check: { iv: '', ciphertext: '' } };
  const aad = context(h, 'check');
  const k = hmacSign(root, context(h, 'check-key'));
  try { h.check = seal(k, aad, encoder.encode('odd-vault-check-v1')); return h; }
  finally { secureZero(k); }
}
export function verifyRecoveryHeader(root: Uint8Array, h: OddRecoveryHeader): void {
  key(root);
  parseRecoveryHeader(h);
  const k = hmacSign(root, context(h, 'check-key'));
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = open(k, context(h, 'check'), h.check, 18);
    if (new TextDecoder().decode(plaintext) !== 'odd-vault-check-v1') fail();
  } finally { secureZero(k); if (plaintext) secureZero(plaintext); }
}
/**
 * Proof that the caller holds the root behind `h` (B2 rotation): the header's check key,
 * HMAC-SHA256(root, binding `check-key`), as canonical base64. The server proves it by
 * opening the stored check with it. It opens nothing else: it is neither the root nor a
 * wrapping key. Verifies the header first, so a wrong phrase never produces a proof.
 */
export function deriveRecoveryRootProof(root: Uint8Array, h: OddRecoveryHeader): string {
  verifyRecoveryHeader(root, h);
  const k = hmacSign(root, context(h, 'check-key'));
  try { return uint8ArrayToBase64(k); } finally { secureZero(k); }
}
/** A fresh vault id (random UUIDv4, canonical lowercase) for a new or replacement header. */
export function createRecoveryVaultId(): string {
  const b = generateRandomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (value) => value.toString(16).padStart(2, '0')).join('');
  secureZero(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function deriveAppRecoveryWrappingKey(root: Uint8Array, h: OddRecoveryHeader, appCode: string): Uint8Array {
  verifyRecoveryHeader(root, h);
  return hmacSign(root, context(h, 'app-wrapping-key', appCode));
}
export function wrapAppRecoveryKey(k: Uint8Array, h: OddRecoveryHeader, appCode: string, revision: number, existingAppKey: Uint8Array): OddAppKeyCapsule {
  if (!(existingAppKey instanceof Uint8Array) || existingAppKey.length < 1 || existingAppKey.length > 16384) fail();
  return { format: 'odd-app-key-capsule-v1', accountId: h.accountId, vaultId: h.vaultId, appCode, revision,
    wrappedKey: seal(k, context(h, 'app-key', appCode, revision), existingAppKey) };
}
export function unwrapAppRecoveryKey(k: Uint8Array, h: OddRecoveryHeader, capsule: OddAppKeyCapsule): Uint8Array {
  header(h);
  if (!capsule || capsule.format !== 'odd-app-key-capsule-v1' || capsule.accountId !== h.accountId || capsule.vaultId !== h.vaultId) fail();
  return open(k, context(h, 'app-key', capsule.appCode, capsule.revision), capsule.wrappedKey, -1);
}
