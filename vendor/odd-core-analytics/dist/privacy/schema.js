"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActiveClock = exports.UUID = exports.PLATFORMS = exports.DIAGNOSTICS_DISCLOSURE = exports.USAGE_DISCLOSURE = exports.DEFAULT_FRAMES = exports.ERROR_CATEGORIES = exports.HANSEL_FEATURES = exports.DEFAULT_COLLECTOR = void 0;
exports.record = record;
exports.sanitizeMetric = sanitizeMetric;
exports.sanitizeDiagnostic = sanitizeDiagnostic;
exports.collectorOrigin = collectorOrigin;
/** MIT. Counters and structural errors only; never forward caller property bags. */
exports.DEFAULT_COLLECTOR = 'https://data.odd.community';
exports.HANSEL_FEATURES = ['home', 'recordings', 'vocabulary', 'shortcuts', 'dictation'];
exports.ERROR_CATEGORIES = ['crash', 'unhandled_exception', 'render_error', 'ipc_error', 'ml_error'];
exports.DEFAULT_FRAMES = ['app:///main/index.js', 'app:///renderer/index.js'];
exports.USAGE_DISCLOSURE = 'Share active time, recording duration, feature counts and outcomes, app version and platform with our own servers. A random ID unique to this app measures returning installations. Never audio, transcripts, prompts, account details or screen recordings.';
exports.DIAGNOSTICS_DISCLOSURE = 'Share sanitized error categories, app version and code locations with our own Sentry server. Never error text, account details, recordings or memory dumps.';
exports.PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android', 'web'];
exports.UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASSES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError'];
function record(input) {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? input : null;
}
function sanitizeMetric(input, features = exports.HANSEL_FEATURES) {
    const v = record(input);
    if (!v)
        return null;
    if (v.event === 'active')
        return { event: 'active' };
    if (v.event === 'feature' && typeof v.feature === 'string' && features.includes(v.feature))
        return { event: 'feature', feature: v.feature };
    if (v.event === 'result' && typeof v.feature === 'string' && features.includes(v.feature) && (v.outcome === 'success' || v.outcome === 'failure'))
        return { event: 'result', feature: v.feature, outcome: v.outcome };
    if (v.event === 'usage' && Number.isInteger(v.active_ms) && Number(v.active_ms) > 0 && Number(v.active_ms) <= 60000)
        return { event: 'usage', active_ms: Number(v.active_ms) };
    if (v.event === 'recording' && Number.isInteger(v.recording_ms) && Number(v.recording_ms) > 0 && Number(v.recording_ms) <= 86400000)
        return { event: 'recording', recording_ms: Number(v.recording_ms) };
    return null;
}
function sanitizeDiagnostic(input, allowedFrames = exports.DEFAULT_FRAMES) {
    const v = record(input);
    if (!v || v.event !== 'error' || !exports.ERROR_CATEGORIES.includes(v.category))
        return null;
    const frames = [];
    if (Array.isArray(v.frames))
        for (const inputFrame of v.frames.slice(-8)) {
            const f = record(inputFrame);
            if (f && typeof f.filename === 'string' && allowedFrames.includes(f.filename) &&
                Number.isInteger(f.lineno) && Number(f.lineno) > 0 && Number(f.lineno) <= 10000000 &&
                Number.isInteger(f.colno) && Number(f.colno) >= 0 && Number(f.colno) <= 10000000) {
                frames.push({ filename: f.filename, lineno: Number(f.lineno), colno: Number(f.colno) });
            }
        }
    return { event: 'error', category: v.category,
        error_class: typeof v.error_class === 'string' && CLASSES.includes(v.error_class) ? v.error_class : 'Error',
        version: typeof v.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v.version) ? v.version : '0.0.0', frames };
}
function collectorOrigin(input) {
    const u = new URL(input);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
        /(^|\.)(posthog\.com|posthog\.net|google\.com|googleapis\.com|google-analytics\.com|googletagmanager\.com|firebaseapp\.com|firebaseio\.com)$/.test(u.hostname))
        throw new Error('Use an operator-controlled HTTPS collector origin');
    return u.origin;
}
/** Sample with a monotonic clock; reset at consent/focus lifecycle boundaries. */
class ActiveClock {
    constructor() {
        this.previous = null;
    }
    sample(time, focused, idleSeconds, recording = false) {
        if (!Number.isFinite(time) || !Number.isFinite(idleSeconds) || idleSeconds < 0) {
            this.reset();
            return 0;
        }
        const active = recording || (focused && idleSeconds < 60);
        const previous = this.previous;
        this.previous = { time, active };
        if (!previous || !previous.active || !active)
            return 0;
        const delta = time - previous.time;
        return delta > 0 && delta <= 15000 ? Math.floor(delta) : 0;
    }
    reset() { this.previous = null; }
}
exports.ActiveClock = ActiveClock;
