// Build only the pinned privacy/gateway entry points, without changing the source checkout.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const source = resolve(process.argv[2] || '../odd-core-kits/packages/analytics')
const revision = process.argv[3] || '3fb6fb095a1f9b1b8601965df58f08521fc38f7f'
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Supply a full source commit SHA')
const repository = execFileSync('git', ['-C', source, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const prefix = relative(repository, source).replaceAll('\\', '/')
const target = resolve('vendor/odd-core-analytics'), build = mkdtempSync(join(tmpdir(), 'watcher-analytics-pin-'))
const hashes = {}, sourceHashes = {}
const digest = value => createHash('sha256').update(value).digest('hex')
const committed = file => {
  const data = execFileSync('git', ['-C', repository, 'show', `${revision}:${prefix}/${file}`])
  sourceHashes[file] = digest(data)
  return data
}
const save = (file, data) => {
  mkdirSync(join(target, file, '..'), { recursive: true }); writeFileSync(join(target, file), data); hashes[file] = digest(data)
}
try {
  const manifest = JSON.parse(committed('package.json'))
  for (const file of ['README.md', 'LICENSE', 'gateway/server.mjs']) save(file, committed(file))
  const sources = ['index', 'client', 'schema'].map(name => {
    const file = `src/privacy/${name}.ts`, destination = join(build, file)
    mkdirSync(join(destination, '..'), { recursive: true }); writeFileSync(destination, committed(file)); return destination
  })
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--target', 'ES2020', '--module', 'commonjs',
    '--strict', '--skipLibCheck', '--declaration', '--outDir', join(build, 'dist/privacy'), ...sources], { stdio: 'inherit' })
  for (const name of ['index', 'client', 'schema']) for (const extension of ['js', 'd.ts']) {
    const file = `dist/privacy/${name}.${extension}`; save(file, readFileSync(join(build, file)))
  }
  save('package.json', JSON.stringify({ name: manifest.name, version: manifest.version, license: manifest.license,
    description: 'Pinned Odd Core privacy and gateway entry points',
    exports: { './privacy': { types: './dist/privacy/index.d.ts', default: './dist/privacy/index.js' }, './gateway': './gateway/server.mjs' } }, null, 2) + '\n')
  writeFileSync(join(target, 'PROVENANCE.json'), JSON.stringify({ source: 'OddCommunity/odd-core-kits/packages/analytics',
    revision, version: manifest.version, dirty: false, compiler: JSON.parse(readFileSync('node_modules/typescript/package.json')).version,
    sourceHashes, hashes }, null, 2) + '\n')
  console.log(`Pinned shared analytics ${manifest.version} to ${revision}`)
} finally { rmSync(build, { recursive: true, force: true }) }
