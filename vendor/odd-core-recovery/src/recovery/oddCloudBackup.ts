/** Explicit app-owned operations. Sign-in never creates or replaces a backup. Each app passes its own rollout flag. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export type OddRecoveryAppCode = 'bestfriend' | 'privately' | 'qg' | 'watcher';
/**
 * accountId is the verified Odd UUID (vault binding only). storageOwnerId owns backup paths and
 * pointers in the app's own project: the Odd UUID for third-party-auth apps (Raw Daily, BestFriend),
 * the app pseudonym for QG, which must never store under the Odd account id.
 */
export type VerifiedRecoveryOwner = { accountId: string; vaultId: string; generation: number; appOwnerId: string; storageOwnerId: string };
const PSEUDONYMOUS_STORAGE: ReadonlySet<OddRecoveryAppCode> = new Set(['qg']);
export function sameRecoveryOwner(a: VerifiedRecoveryOwner, b: VerifiedRecoveryOwner): boolean {
  return a.accountId === b.accountId && a.vaultId === b.vaultId && a.appOwnerId === b.appOwnerId && a.storageOwnerId === b.storageOwnerId && a.generation === b.generation;
}
/** part_paths: this snapshot's chunk object paths (empty when unchunked), so the app server can GC superseded chunks through the Storage API without the encrypted manifest. */
export type BackupPointer = { app_code: string; user_id: string; version: number; object_path: string; crypto_version: number; size_bytes: number; part_paths: string[] };
export interface CloudBackupPorts {
  owner(): Promise<VerifiedRecoveryOwner>;
  activeMember(): Promise<boolean>;
  /** Authenticated app-scoped immutable object upload, upsert=false. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  latest(): Promise<BackupPointer | null>;
  /** Server row CAS: initial INSERT, otherwise UPDATE WHERE version=expected. */
  publish(pointer: BackupPointer, expected: number): Promise<boolean>;
  /**
   * Optional (B2): vault ids this account replaced by a phrase reset or rotation, newest first
   * (`get_odd_recovery_reset_status().prior_vault_ids`). Backups sealed before the change bind the
   * old vault id; restore tries these after the current one, so an app that re-enrolled its same
   * keys can still restore its last backup until it uploads a new one.
   */
  priorVaultIds?(): Promise<readonly string[]>;
}
export interface SnapshotAdapter {
  capture(owner: VerifiedRecoveryOwner): Promise<Uint8Array>;
  /** Stage, validate schema/keybag and all media before any live changes. */
  stage(bytes: Uint8Array, owner: VerifiedRecoveryOwner): Promise<{ commit(checkCurrent: () => Promise<void>): Promise<void>; discard(): Promise<void> }>;
}
export interface SnapshotCipher {
  destroy?(): void;
  /** Revision of the app key capsule whose keys this cipher holds (default 1); recorded in the manifest. */
  readonly capsuleRevision?: number;
  /** AEAD binds canonical account, app, object version and application owner. */
  randomObjectId(): number;
  digest(bytes: Uint8Array): Promise<string>;
  seal(bytes: Uint8Array, context: string): Promise<Uint8Array>;
  open(bytes: Uint8Array, context: string): Promise<Uint8Array>;
}
/** Canonical lowercase RFC 9562 UUID, versions 1-8 (QG's pseudonymous owner ids are UUIDv8). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** accountId must be the verified Odd UUID; paths and pointers use storageOwnerId (QG: its pseudonym). */
export class OddCloudBackup {
  private generation = 0;
  private busy = false;
  constructor(private readonly appCode: OddRecoveryAppCode, private readonly ports: CloudBackupPorts,
    private readonly snapshot: SnapshotAdapter, private readonly cipher: SnapshotCipher,
    private readonly enabled = false) {}
  cancel(): void { this.generation++; }
  private async operation<T>(run: (owner: VerifiedRecoveryOwner, check: () => Promise<void>) => Promise<T>): Promise<T> {
    if (!this.enabled) throw new Error('Odd recovery rollout is disabled');
    if (this.busy) throw new Error('Recovery operation already running');
    this.busy = true;
    const generation = this.generation;
    try {
      const owner = await this.ports.owner();
      if (!UUID.test(owner.accountId) || !UUID.test(owner.vaultId) || !owner.appOwnerId || typeof owner.storageOwnerId !== 'string' || !UUID.test(owner.storageOwnerId) || !Number.isSafeInteger(owner.generation)) throw new Error('Verified recovery identity required');
      if (PSEUDONYMOUS_STORAGE.has(this.appCode) && owner.storageOwnerId === owner.accountId) throw new Error(`${this.appCode} backups must be stored under the app pseudonym, never the Odd account id`);
      const check = async () => {
        const next = await this.ports.owner();
        if (generation !== this.generation || !sameRecoveryOwner(owner, next)) throw new Error('Recovery operation cancelled or account changed');
      };
      await check();
      return await run(owner, check);
    } finally { this.busy = false; }
  }
  backup(): Promise<void> {
    return this.operation(async (owner, check) => {
      const capsuleRevision = this.cipher.capsuleRevision ?? 1;
      if (!Number.isSafeInteger(capsuleRevision) || capsuleRevision < 1) throw new Error('Invalid app key capsule revision');
      if (!await this.ports.activeMember()) throw new Error('Active Odd membership required to back up');
      await check();
      const previous = await this.ports.latest();
      await check();
      if (previous) this.validatePointer(previous, owner);
      const priorVersion = previous?.version ?? 0;
      const room = Number.MAX_SAFE_INTEGER - priorVersion;
      if (room < 1) throw new Error('Backup version space exhausted');
      const version = priorVersion + 1 + (this.cipher.randomObjectId() % Math.min(room, 1_000_000_000));
      const path = `${this.appCode}/${owner.storageOwnerId}/${version}.blob`;
      const bytes = await this.snapshot.capture(owner);
      try {
        await check();
        if (!bytes.length || bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds bounded cloud backup capacity');
        const parts: { path: string; size: number; digest: string }[] = [];
        for (let at = 0; at < bytes.length; at += 4 * 1024 * 1024) {
          const part = bytes.subarray(at, Math.min(bytes.length, at + 4 * 1024 * 1024));
          const context = `${this.context(owner, version)}:chunk:${parts.length}`;
          const encrypted = await this.cipher.seal(part, context);
          const id = this.cipher.randomObjectId();
          if (!Number.isSafeInteger(id) || id < 1_000_000_000_000) throw new Error('Invalid random storage object ID');
          const chunkPath = `${this.appCode}/${owner.storageOwnerId}/${id}.blob`;
          await check();
          await this.ports.upload(chunkPath, encrypted);
          await check();
          const downloaded = await this.ports.download(chunkPath);
          await check();
          const digest = await this.cipher.digest(encrypted);
          if (downloaded.length !== encrypted.length || await this.cipher.digest(downloaded) !== digest) throw new Error('Cloud chunk read-back differs');
          const verified = await this.cipher.open(downloaded, context);
          try {
            if (verified.length !== part.length || verified.some((value, i) => value !== part[i])) throw new Error('Cloud chunk plaintext differs');
          } finally { verified.fill(0); }
          parts.push({ path: chunkPath, size: encrypted.length, digest });
        }
        const manifest = new TextEncoder().encode(JSON.stringify({ format: 'odd-full-snapshot-v1', capsuleRevision, size: bytes.length, parts }));
        const encrypted = await this.cipher.seal(manifest, this.context(owner, version));
        manifest.fill(0);
        await check();
        await this.ports.upload(path, encrypted);
        await check();
        const downloaded = await this.ports.download(path);
        await check();
        if (await this.cipher.digest(downloaded) !== await this.cipher.digest(encrypted)) throw new Error('Cloud manifest read-back differs');
        await check();
        if (!await this.ports.activeMember()) throw new Error('Membership expired during backup');
        await check();
        if (!await this.ports.publish({ app_code: this.appCode, user_id: owner.storageOwnerId, version, object_path: path, crypto_version: 1, size_bytes: encrypted.length + parts.reduce((sum, part) => sum + part.size, 0), part_paths: parts.map((part) => part.path) }, previous?.version ?? 0)) throw new Error('Another device completed a backup; current pointer preserved');
        await check();
      } finally { bytes.fill(0); }
    });
  }
  /** Existing completed backups remain readable after membership expires. */
  restore(confirm?: () => Promise<boolean>): Promise<boolean> {
    return this.operation(async (owner, check) => {
      const pointer = await this.ports.latest();
      await check();
      if (!pointer) throw new Error('No completed cloud backup');
      this.validatePointer(pointer, owner);
      const encrypted = await this.ports.download(pointer.object_path);
      await check();
      if (!encrypted.length || encrypted.length > 50 * 1024 * 1024) throw new Error('Invalid root manifest object size');
      // sealedBy: the owner as it was when this backup was made (its vault id may predate a reset).
      const { plain: manifestBytes, sealedBy } = await this.openRootManifest(encrypted, owner, pointer.version, check);
      let manifest: { format: string; capsuleRevision: number; size: number; parts: {path: string; size: number; digest: string}[] };
      try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
      finally { manifestBytes.fill(0); }
      if (manifest.format !== 'odd-full-snapshot-v1' || !Number.isSafeInteger(manifest.capsuleRevision) || manifest.capsuleRevision < 1 || !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > MAX_SNAPSHOT_BYTES || !Array.isArray(manifest.parts) || manifest.parts.length !== Math.ceil(manifest.size / (4 * 1024 * 1024))) throw new Error('Invalid completed snapshot manifest');
      if (manifest.parts.reduce((sum, part) => sum + (part?.size ?? 0), encrypted.length) !== pointer.size_bytes) throw new Error('Backup total storage size does not match manifest');
      const bytes = new Uint8Array(manifest.size);
      const paths = new Set<string>();
      let offset = 0;
      try {
        for (const [index, part] of manifest.parts.entries()) {
          const prefix = `${this.appCode}/${owner.storageOwnerId}/`;
          if (!part || typeof part.path !== 'string' || !part.path.startsWith(prefix) || !/^[1-9][0-9]*[.]blob$/.test(part.path.slice(prefix.length)) || paths.has(part.path) || part.path === pointer.object_path || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 50 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(part.digest)) throw new Error('Invalid snapshot chunk metadata');
          paths.add(part.path);
          const ciphertext = await this.ports.download(part.path);
          await check();
          if (ciphertext.length !== part.size || await this.cipher.digest(ciphertext) !== part.digest) throw new Error('Incomplete or damaged snapshot chunk');
          const plain = await this.cipher.open(ciphertext, `${this.context(sealedBy, pointer.version)}:chunk:${index}`);
          try {
            if (plain.length !== Math.min(4 * 1024 * 1024, manifest.size - offset)) throw new Error('Invalid snapshot chunk size');
            bytes.set(plain, offset); offset += plain.length;
          } finally { plain.fill(0); }
        }
      } catch (error) { bytes.fill(0); throw error; }
      let staged: Awaited<ReturnType<SnapshotAdapter['stage']>> | undefined;
      try {
        await check();
        if (!bytes.length || bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('Invalid snapshot capacity');
        // The current owner: sealedBy (a prior vault id) only opened the bytes.
        staged = await this.snapshot.stage(bytes, owner);
        await check();
        if (confirm && !await confirm()) return false;
        await check();
        await staged.commit(check);
        return true;
      } finally { bytes.fill(0); await staged?.discard(); }
    });
  }
  /** Current vault id first, then the account's prior vault ids (at most 16, canonical UUIDs only). */
  private async openRootManifest(encrypted: Uint8Array, owner: VerifiedRecoveryOwner, version: number, check: () => Promise<void>):
    Promise<{ plain: Uint8Array; sealedBy: VerifiedRecoveryOwner }> {
    try { return { plain: await this.cipher.open(encrypted, this.context(owner, version)), sealedBy: owner }; }
    catch (current) {
      if (!this.ports.priorVaultIds) throw current;
      const prior = await this.ports.priorVaultIds();
      await check();
      if (!Array.isArray(prior)) throw current;
      for (const vaultId of prior.slice(0, 16)) {
        if (typeof vaultId !== 'string' || !UUID.test(vaultId) || vaultId === owner.vaultId) continue;
        const sealedBy = { ...owner, vaultId };
        try { return { plain: await this.cipher.open(encrypted, this.context(sealedBy, version)), sealedBy }; }
        catch { /* sealed under another vault id; try the next */ }
      }
      throw current;
    }
  }
  private context(owner: VerifiedRecoveryOwner, version: number): string {
    return JSON.stringify(['odd-full-snapshot-v1', this.appCode, owner.accountId, owner.vaultId, owner.appOwnerId, version]);
  }
  private validatePointer(pointer: BackupPointer, owner: VerifiedRecoveryOwner): void {
    const prefix = `${this.appCode}/${owner.storageOwnerId}/`;
    const maxParts = Math.ceil(MAX_SNAPSHOT_BYTES / (4 * 1024 * 1024));
    const isChunkPath = (value: unknown): boolean => typeof value === 'string' && value.startsWith(prefix) && /^[1-9][0-9]*[.]blob$/.test(value.slice(prefix.length)) && value !== pointer.object_path;
    if (pointer.app_code !== this.appCode || pointer.user_id !== owner.storageOwnerId || !Number.isSafeInteger(pointer.version) || pointer.version < 1 || pointer.object_path !== `${prefix}${pointer.version}.blob` || pointer.crypto_version !== 1 || !Number.isSafeInteger(pointer.size_bytes) || pointer.size_bytes < 1 || pointer.size_bytes > MAX_SNAPSHOT_BYTES + 1024 * 1024 || !Array.isArray(pointer.part_paths) || pointer.part_paths.length > maxParts || pointer.part_paths.some((value, index) => !isChunkPath(value) || pointer.part_paths.indexOf(value) !== index)) throw new Error('Invalid app/account backup pointer');
  }
}
