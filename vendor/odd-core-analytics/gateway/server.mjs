/** MIT licensed. Restricted public intake for a private PostHog instance. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const features = new Set(['home', 'recordings', 'vocabulary', 'shortcuts', 'dictation'])

export function sanitizeBatch(body, tokens) {
  const project = typeof body?.api_key === 'string' && Object.hasOwn(tokens, body.api_key) ? tokens[body.api_key] : null
  if (!project || typeof project.token !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(project.app) || !Array.isArray(body.batch) || body.batch.length < 1 || body.batch.length > 50) return null
  const batch = []
  for (const row of body.batch) {
    const p = row?.properties
    const time = Date.parse(row?.timestamp)
    if (typeof row?.uuid !== 'string' || !uuid.test(row.uuid) || typeof p?.distinct_id !== 'string' || !uuid.test(p.distinct_id) || !Number.isFinite(time) ||
        time > Date.now() + 300000 || Date.now() - time > 7 * 86400000 || p.app !== project.app) return null
    let metric
    if (row.event === 'app_active') metric = {}
    else if (row.event === 'app_usage' && Number.isInteger(p.active_ms) && p.active_ms > 0 && p.active_ms <= 60000) metric = { active_ms: p.active_ms }
    else if (row.event === 'app_recording' && Number.isInteger(p.recording_ms) && p.recording_ms > 0 && p.recording_ms <= 86400000) metric = { recording_ms: p.recording_ms }
    else if (row.event === 'app_feature' && (project.features ? project.features.includes(p.feature) : features.has(p.feature))) metric = { feature: p.feature }
    else if (row.event === 'app_result' && (project.features ? project.features.includes(p.feature) : features.has(p.feature)) && ['success', 'failure'].includes(p.outcome)) metric = { feature: p.feature, outcome: p.outcome }
    else return null
    const metadata = {}
    if (typeof p.app_version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(p.app_version)) metadata.app_version = p.app_version
    if (['macos', 'windows', 'linux', 'ios', 'android', 'web'].includes(p.app_platform)) metadata.app_platform = p.app_platform
    batch.push({ uuid: row.uuid, timestamp: new Date(time).toISOString(), event: row.event,
      properties: { distinct_id: p.distinct_id, app: project.app, ...metric, ...metadata,
        $process_person_profile: false, $geoip_disable: true } })
  }
  return { api_key: project.token, batch }
}

export function sanitizeDiagnostics(body, projects) {
  const project = typeof body?.api_key === 'string' && Object.hasOwn(projects, body.api_key) ? projects[body.api_key] : null
  if (!project || !/^[a-z][a-z0-9-]{0,63}$/.test(project.app) || !Number.isInteger(project.project_id) || project.project_id < 1 ||
      typeof project.public_key !== 'string' || !/^[a-f0-9]{32}$/.test(project.public_key) ||
      !Array.isArray(body.batch) || body.batch.length < 1 || body.batch.length > 10) return null
  const categories = new Set(['crash', 'unhandled_exception', 'render_error', 'ipc_error', 'ml_error'])
  const classes = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'])
  const events = []
  for (const row of body.batch) {
    const d = row?.diagnostic, time = Date.parse(row?.timestamp)
    if (typeof row?.uuid !== 'string' || !uuid.test(row.uuid) || !Number.isFinite(time) ||
        time > Date.now() + 300000 || Date.now() - time > 7 * 86400000 || d?.event !== 'error' || !categories.has(d.category)) return null
    const frames = []
    if (Array.isArray(d.frames)) for (const f of d.frames.slice(-8)) {
      if (f && (project.frames || ['app:///main/index.js', 'app:///renderer/index.js']).includes(f.filename) &&
          Number.isInteger(f.lineno) && f.lineno > 0 && f.lineno <= 10000000 &&
          Number.isInteger(f.colno) && f.colno >= 0 && f.colno <= 10000000) {
        frames.push({ filename: f.filename, lineno: f.lineno, colno: f.colno, in_app: true })
      }
    }
    events.push({ event_id: row.uuid.replaceAll('-', ''), timestamp: new Date(time).toISOString(), platform: ['javascript', 'cocoa', 'java', 'other'].includes(project.platform) ? project.platform : 'javascript', level: 'error',
      release: project.app + '@' + (typeof d.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(d.version) ? d.version : '0.0.0'),
      exception: { values: [{ type: classes.has(d.error_class) ? d.error_class : 'Error', value: project.app + ' ' + d.category,
        ...(frames.length ? { stacktrace: { frames } } : {}) }] }, tags: { category: d.category, app: project.app } })
  }
  return { project, events }
}

export function makeServer({ upstream, tokens, diagnostics = {}, sentryOrigin = 'http://sentry-ingress', allowedOrigins = [], send = fetch }) {
  let windowStart = Date.now(), requests = 0
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const origin = req.headers.origin
    if (origin && !allowedOrigins.includes(origin)) { res.writeHead(403); res.end(); return }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.method === 'OPTIONS' && ['/batch/', '/errors/'].includes(req.url)) {
        res.setHeader('Access-Control-Allow-Methods', 'POST')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.writeHead(204); res.end(); return
      }
    }
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('ok'); return }
    if (req.method !== 'POST' || !['/batch/', '/errors/'].includes(req.url)) { res.writeHead(404); res.end(); return }
    if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); res.end(); return }
    if (Date.now() - windowStart > 60000) { windowStart = Date.now(); requests = 0 }
    if (++requests > 3000) { res.writeHead(429, { 'Retry-After': '60' }); res.end(); return }
    try {
      const chunks = []; let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > 65536) { res.writeHead(413); res.end(); return }
        chunks.push(chunk)
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === '/errors/') {
        const payload = sanitizeDiagnostics(input, diagnostics)
        if (!payload) { res.writeHead(400); res.end(); return }
        const results = await Promise.all(payload.events.map(async event => {
          const response = await send(`${sentryOrigin}/api/${payload.project.project_id}/store/`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
            headers: { 'Content-Type': 'application/json', 'X-Sentry-Auth': 'Sentry sentry_version=7,sentry_key=' + payload.project.public_key },
            body: JSON.stringify(event),
          })
          await response.body?.cancel()
          return response.ok
        }))
        res.writeHead(results.every(Boolean) ? 200 : 503); res.end(); return
      }
      const payload = sanitizeBatch(input, tokens)
      if (!payload) { res.writeHead(400); res.end(); return }
      const response = await send(upstream, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        // Never forward source IP, cookies, auth, user agent, or incoming headers.
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      await response.body?.cancel()
      res.writeHead(response.ok ? 200 : 503); res.end()
    } catch { res.writeHead(503); res.end() }
  })
  server.requestTimeout = 10000; server.headersTimeout = 10000
  server.maxConnections = 64
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokens = JSON.parse(readFileSync(process.env.PROJECT_TOKENS_FILE, 'utf8'))
  const upstream = new URL(process.env.POSTHOG_UPSTREAM || 'http://proxy:80/batch/')
  if (!['proxy', '127.0.0.1', 'localhost'].includes(upstream.hostname)) throw Error('Upstream must be the private local PostHog service')
  const diagnostics = process.env.SENTRY_PROJECTS_FILE ? JSON.parse(readFileSync(process.env.SENTRY_PROJECTS_FILE, 'utf8')) : {}
  const sentry = new URL(process.env.SENTRY_UPSTREAM || 'http://sentry-ingress')
  if (!['sentry-ingress', '127.0.0.1', 'localhost'].includes(sentry.hostname) || sentry.pathname !== '/' || sentry.username || sentry.password || sentry.search || sentry.hash) throw Error('Invalid private Sentry origin')
  makeServer({ upstream: upstream.href, tokens, diagnostics, sentryOrigin: sentry.origin, allowedOrigins: JSON.parse(process.env.ALLOWED_ORIGINS || '[]') }).listen(8080, '0.0.0.0')
}
