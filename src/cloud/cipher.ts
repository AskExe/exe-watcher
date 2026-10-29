import { CloudError } from './error.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { SnapshotCipher } from '@odd-core/recovery/backup'

/** Node adapter for the shared Odd backup engine. GCM authenticates the engine's full owner/version context. */
export function snapshotCipher(key: Uint8Array, capsuleRevision: number): SnapshotCipher {
  if (key.length !== 32) throw new CloudError('Invalid Watcher backup key.')
  const ownedKey = Buffer.from(key)
  return {
    capsuleRevision,
    destroy() { ownedKey.fill(0) },
    randomObjectId() { return 1_000_000_000_000 + Number(randomBytes(6).readUIntBE(0, 6)) },
    async digest(bytes) { return createHash('sha256').update(bytes).digest('hex') },
    async seal(bytes, context) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', ownedKey, iv)
      cipher.setAAD(Buffer.from(context))
      return Buffer.concat([Buffer.from([1]), iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
    },
    async open(bytes, context) {
      if (bytes.length < 30 || bytes[0] !== 1) throw new CloudError('Invalid encrypted history.')
      const decipher = createDecipheriv('aes-256-gcm', ownedKey, bytes.subarray(1, 13))
      decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      return Buffer.concat([decipher.update(bytes.subarray(13, bytes.length - 16)), decipher.final()])
    },
  }
}
