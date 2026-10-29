/**
 * App key capsule revision contract, shared by every Odd app (QG, Raw Daily,
 * BestFriend). Pure functions: callers bring their own RPC transport.
 *
 * Server contract (put_odd_app_key_capsule): the capsule revision must be
 * p_expected_revision + 1; expected 0 enrolls revision 1; otherwise the row is
 * updated only WHERE revision = expected. A stale expected revision raises
 * PT409 (HTTP 409 Conflict) and never overwrites. Before migration
 * 20261013010001 it raised 40001, which PostgREST retried without limit.
 */
import { wrapAppRecoveryKey, type OddAppKeyCapsule, type OddRecoveryHeader } from '../core/account-recovery';

const CAPSULE_KEYS = 'accountId,appCode,format,revision,vaultId,wrappedKey';

function unsupported(): never { throw new Error('Unsupported app key capsule'); }

/** Validate an untrusted capsule from get_odd_app_key_capsule. Accepts any revision >= 1. */
export function parseAppKeyCapsule(value: unknown, header: OddRecoveryHeader, appCode: string): OddAppKeyCapsule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unsupported();
  const capsule = value as OddAppKeyCapsule;
  if (Object.keys(capsule).sort().join(',') !== CAPSULE_KEYS || capsule.format !== 'odd-app-key-capsule-v1' ||
      capsule.appCode !== appCode || capsule.accountId !== header.accountId || capsule.vaultId !== header.vaultId ||
      !Number.isSafeInteger(capsule.revision) || capsule.revision < 1 ||
      !capsule.wrappedKey || typeof capsule.wrappedKey !== 'object' || Array.isArray(capsule.wrappedKey)) unsupported();
  return capsule;
}

/**
 * Build the next capsule and the CAS argument for put_odd_app_key_capsule:
 * `{ p_capsule: capsule, p_expected_revision: expectedRevision }`.
 * `current` is the capsule as last read from the server (null when none exists),
 * so expectedRevision is always the revision the caller actually saw.
 */
export function nextAppKeyCapsule(wrappingKey: Uint8Array, header: OddRecoveryHeader, appCode: string,
  current: OddAppKeyCapsule | null, bundle: Uint8Array): { capsule: OddAppKeyCapsule; expectedRevision: number } {
  const expectedRevision = current ? parseAppKeyCapsule(current, header, appCode).revision : 0;
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('App key capsule revision space exhausted');
  return { capsule: wrapAppRecoveryKey(wrappingKey, header, appCode, expectedRevision + 1, bundle), expectedRevision };
}

/**
 * True when put_odd_app_key_capsule refused a stale expected revision: SQLSTATE PT409 (HTTP 409).
 * 40001 is still accepted from servers that predate migration 20261013010001.
 */
export function isAppKeyCapsuleConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'PT409' || code === '40001';
}
