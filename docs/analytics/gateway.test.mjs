import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { sanitizeBatch, makeServer } from '@odd-core/analytics/gateway'
const tokens = { 'public-hansel-v1': { app: 'hansel', token: 'private-project-token' } }
const body = () => ({ api_key: 'public-hansel-v1', batch: [{ uuid: randomUUID(), timestamp: new Date().toISOString(), event: 'app_recording', properties: { distinct_id: randomUUID(), app: 'hansel', recording_ms: 15000 } }] })

test('strips content and identifying fields before forwarding to PostHog', () => {
  const input = body()
  Object.assign(input.batch[0].properties, { text: 'PRIVATE', email: 'PRIVATE', $ip: 'PRIVATE', $set: { name: 'PRIVATE' } })
  input.batch[0].unexpected = 'PRIVATE'
  const result = sanitizeBatch(input, tokens)
  assert.ok(result)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  assert.equal(result.api_key, 'private-project-token')
})

test('rejects cross-project writes, unknown events, invalid IDs and durations', () => {
  for (const mutate of [b => { b.api_key = 'unknown' }, b => { b.api_key = '__proto__' }, b => { b.batch[0].properties.distinct_id = [randomUUID()] }, b => { b.batch[0].properties.app = 'other-app' }, b => { b.batch[0].properties.recording_ms = -1 }, b => { b.batch[0].event = 'transcript' }, b => { b.batch[0].properties.distinct_id = 'email@example.org' }]) {
    const input = body(); mutate(input); assert.equal(sanitizeBatch(input, tokens), null)
  }
})

test('public route cannot read PostHog and forwarded requests contain no source headers', async () => {
  let forwarded
  const server = makeServer({ upstream: 'http://private/batch/', tokens, send: async (url, options) => { forwarded = { url, options }; return new Response('{}') } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(address + '/api/projects/')).status, 404)
    assert.equal((await fetch(address + '/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'private-ip', Cookie: 'private-cookie' }, body: JSON.stringify(body()) })).status, 200)
    assert.deepEqual(forwarded.options.headers, { 'Content-Type': 'application/json' })
    assert.equal(forwarded.options.redirect, 'error')
    assert.equal((await fetch(address + '/batch/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(), api_key: 'wrong-project' }) })).status, 400)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('diagnostics reconstruct only approved fields and cannot choose another Sentry project', async () => {
  const { sanitizeDiagnostics } = await import('@odd-core/analytics/gateway')
  const projects = { 'public-hansel-v1': { app: 'hansel', project_id: 2, public_key: 'a'.repeat(32) } }
  const input = { api_key: 'public-hansel-v1', batch: [{ uuid: randomUUID(), timestamp: new Date().toISOString(),
    diagnostic: { event: 'error', category: 'ipc_error', error_class: 'TypeError', version: '1.0.39',
      message: 'PRIVATE', user: { email: 'PRIVATE' }, extra: { transcript: 'PRIVATE' },
      frames: [{ filename: '/Users/PRIVATE/transcript.txt', lineno: 1, colno: 0 }, { filename: 'app:///main/index.js', lineno: 12, colno: 2, vars: { token: 'PRIVATE' } }] } }] }
  const result = sanitizeDiagnostics(input, projects)
  assert.ok(result)
  assert.equal(JSON.stringify(result.events).includes('PRIVATE'), false)
  assert.equal(result.events[0].exception.values[0].stacktrace.frames.length, 1)
  assert.equal(sanitizeDiagnostics({ ...input, api_key: '__proto__' }, projects), null)
  let forwarded
  const server = makeServer({ upstream: 'http://private/batch/', tokens, diagnostics: projects, sentryOrigin: 'http://sentry-private',
    send: async (url, options) => { forwarded = { url, options }; return new Response('{}') } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(origin + '/errors/', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'PRIVATE', 'X-Forwarded-For': 'PRIVATE' }, body: JSON.stringify(input) })).status, 200)
    assert.equal(forwarded.url, 'http://sentry-private/api/2/store/')
    assert.equal(JSON.stringify(forwarded.options).includes('PRIVATE'), false)
    assert.equal(forwarded.options.redirect, 'error')
    assert.equal((await fetch(origin + '/api/2/store/', { method: 'POST' })).status, 404)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('Watcher features stay isolated and recording is not fabricated', () => {
  const mapping = { ...tokens, 'public-watcher-cli-v1': { app: 'watcher', token: 'watcher-only', features: ['cli_status'] } }
  const input = body(); input.api_key = 'public-watcher-cli-v1'
  input.batch[0].event = 'app_feature'
  input.batch[0].properties = { distinct_id: randomUUID(), app: 'watcher', feature: 'cli_status', path: 'PRIVATE' }
  assert.equal(sanitizeBatch(input, mapping).api_key, 'watcher-only')
  assert.equal(JSON.stringify(sanitizeBatch(input, mapping)).includes('PRIVATE'), false)
  input.api_key = 'public-hansel-v1'
  assert.equal(sanitizeBatch(input, mapping), null)
  input.api_key = 'public-watcher-cli-v1'; input.batch[0].properties.feature = 'dictation'
  assert.equal(sanitizeBatch(input, mapping), null)
})

test('Watcher outcomes and version/platform are bounded and content-free', () => {
  const mapping = { watch: { app: 'watcher', token: 'private', features: ['cli_status'] } }
  const input = body(); input.api_key = 'watch'
  input.batch[0].event = 'app_result'
  input.batch[0].properties = { distinct_id: randomUUID(), app: 'watcher', feature: 'cli_status', outcome: 'success', app_version: '0.2.67', app_platform: 'macos', message: 'PRIVATE' }
  const safe = sanitizeBatch(input, mapping)
  assert.equal(safe.batch[0].properties.app_version, '0.2.67')
  assert.equal(safe.batch[0].properties.outcome, 'success')
  assert.equal(JSON.stringify(safe).includes('PRIVATE'), false)
  input.batch[0].properties.outcome = 'PRIVATE'
  assert.equal(sanitizeBatch(input, mapping), null)
  input.batch[0].properties.outcome = 'failure'; input.batch[0].properties.feature = 'dictation'
  assert.equal(sanitizeBatch(input, mapping), null)
})
