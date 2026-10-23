"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrivacyClient = void 0;
const schema_1 = require("./schema");
const WEEK = 7 * 86400000;
const empty = () => ({ consent: { usage: false, diagnostics: false }, id: '', usage: [], diagnostics: [] });
/** No SDK autocapture, user context, content strings, cookies, or provider fallback. */
class PrivacyClient {
    constructor(options) {
        this.options = options;
        this.state = empty();
        this.serial = Promise.resolve();
        this.generation = { usage: 0, diagnostics: 0 };
        this.sending = {};
        this.options = { ...options };
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.app) ||
            ![options.usageAlias, options.diagnosticsAlias].every(v => /^[a-zA-Z0-9_-]{1,128}$/.test(v)) ||
            options.features.length > 64 || !options.features.every(v => /^[a-z][a-z0-9_]{0,63}$/.test(v)))
            throw new Error('Invalid static app configuration');
        if (options.appVersion !== undefined && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(options.appVersion))
            throw new Error('Invalid app version');
        if (options.platform !== undefined && !schema_1.PLATFORMS.includes(options.platform))
            throw new Error('Invalid platform');
        this.features = [...options.features];
        this.frames = [...(options.frames ?? schema_1.DEFAULT_FRAMES)];
        if (this.frames.length > 16 || !this.frames.every(v => /^app:\/\/\/[a-zA-Z0-9_/-]+\.(js|ts|swift|kt|dart)$/.test(v) && !v.includes('..')))
            throw new Error('Invalid logical source configuration');
        this.origin = (0, schema_1.collectorOrigin)(options.collector ?? schema_1.DEFAULT_COLLECTOR);
        this.key = `odd-privacy-v1:${options.app}`;
        this.now = options.now ?? Date.now;
    }
    static async create(options) {
        const client = new PrivacyClient(options);
        try {
            const input = (0, schema_1.record)(JSON.parse(await options.storage.getItem(client.key) ?? 'null'));
            // Binding prevents old queued data being routed to a different project's aliases.
            if (!input || input.binding !== client.binding())
                return client;
            const consent = (0, schema_1.record)(input.consent);
            client.state.consent.diagnostics = consent?.diagnostics === true;
            client.state.consent.usage = consent?.usage === true && typeof input.id === 'string' && schema_1.UUID.test(input.id);
            client.state.id = client.state.consent.usage ? input.id : '';
            for (const kind of ['usage', 'diagnostics']) {
                if (!client.state.consent[kind] || !Array.isArray(input[kind]))
                    continue;
                for (const raw of input[kind].slice(-500)) {
                    const row = (0, schema_1.record)(raw);
                    const metric = client.sanitize(kind, row?.metric);
                    if (row && metric && typeof row.uuid === 'string' && schema_1.UUID.test(row.uuid) && client.fresh(row.timestamp)) {
                        client.state[kind].push({ uuid: row.uuid, timestamp: new Date(Date.parse(row.timestamp)).toISOString(), metric });
                    }
                }
            }
            // Remove expired/malformed fields from disk too, not only from memory.
            await client.persist();
        }
        catch {
            client.state = empty();
        }
        return client;
    }
    binding() { return JSON.stringify([this.origin, this.options.app, this.options.usageAlias, this.options.diagnosticsAlias]); }
    fresh(time) {
        const value = typeof time === 'string' ? Date.parse(time) : NaN;
        return Number.isFinite(value) && value <= this.now() && this.now() - value < WEEK;
    }
    sanitize(kind, input) {
        return kind === 'usage' ? (0, schema_1.sanitizeMetric)(input, this.features) : (0, schema_1.sanitizeDiagnostic)(input, this.frames);
    }
    uuid() {
        const id = this.options.randomUUID();
        if (typeof id !== 'string' || !schema_1.UUID.test(id))
            throw new Error('A cryptographic UUID provider is required');
        return id;
    }
    run(fn) {
        const next = this.serial.then(fn);
        this.serial = next.catch(() => undefined);
        return next;
    }
    async persist() {
        try {
            await this.options.storage.setItem(this.key, JSON.stringify({ binding: this.binding(), ...this.state }));
            return true;
        }
        catch {
            this.state = empty();
            this.abort();
            return false;
        }
    }
    status() { return { ...this.state.consent }; }
    /** Call only after the app presents disclosure and records an explicit user choice. */
    setConsent(update) {
        // Abort immediately, including requests blocked behind a slow storage write.
        for (const kind of ['usage', 'diagnostics'])
            if (update[kind] === false) {
                this.generation[kind]++;
                this.sending[kind]?.abort();
            }
        return this.run(async () => {
            try {
                for (const kind of ['usage', 'diagnostics'])
                    if (typeof update[kind] === 'boolean' && this.state.consent[kind] !== update[kind]) {
                        this.generation[kind]++;
                        this.sending[kind]?.abort();
                        this.state.consent[kind] = update[kind];
                        this.state[kind] = [];
                        if (kind === 'usage')
                            this.state.id = update[kind] ? this.uuid() : '';
                    }
                return await this.persist();
            }
            catch {
                this.state = empty();
                this.abort();
                return false;
            }
        });
    }
    track(input) { return this.enqueue('usage', input); }
    report(input) { return this.enqueue('diagnostics', input); }
    enqueue(kind, input) {
        // Sanitize now so caller mutation cannot add content while awaiting storage.
        const metric = this.sanitize(kind, input);
        const generation = this.generation[kind];
        const allowed = this.state.consent[kind];
        return this.run(async () => {
            if (!allowed || !this.state.consent[kind] || generation !== this.generation[kind] || !metric)
                return false;
            try {
                this.state[kind] = this.state[kind].filter(row => this.fresh(row.timestamp)).slice(-499);
                this.state[kind].push({ uuid: this.uuid(), timestamp: new Date(this.now()).toISOString(), metric });
                return await this.persist();
            }
            catch {
                return false;
            }
        });
    }
    /** One bounded batch per channel; schedule retries in the app's lifecycle. */
    async flush() { await Promise.all([this.flushKind('usage'), this.flushKind('diagnostics')]); }
    async flushKind(kind) {
        const requestedGeneration = this.generation[kind];
        const pending = await this.run(async () => {
            if (this.sending[kind] || !this.state.consent[kind] || requestedGeneration !== this.generation[kind])
                return null;
            const before = this.state[kind].length;
            this.state[kind] = this.state[kind].filter(row => this.fresh(row.timestamp));
            if (before !== this.state[kind].length && !await this.persist())
                return null;
            const batch = this.state[kind].slice(0, kind === 'usage' ? 50 : 10);
            if (!batch.length)
                return null;
            const controller = new AbortController();
            this.sending[kind] = controller;
            return { batch, controller, generation: this.generation[kind], id: this.state.id };
        });
        if (!pending)
            return;
        const { batch, controller, generation, id } = pending;
        const timer = setTimeout(() => controller.abort(), kind === 'usage' ? 5000 : 10000);
        try {
            if (controller.signal.aborted)
                return;
            const response = await (this.options.send ?? fetch)(`${this.origin}/${kind === 'usage' ? 'batch' : 'errors'}/`, {
                method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: kind === 'usage' ? this.options.usageAlias : this.options.diagnosticsAlias,
                    batch: batch.map(row => kind === 'diagnostics' ? { uuid: row.uuid, timestamp: row.timestamp, diagnostic: row.metric } : {
                        uuid: row.uuid, timestamp: row.timestamp, event: `app_${row.metric.event}`,
                        properties: { distinct_id: id, app: this.options.app, ...row.metric, ...(this.options.appVersion ? { app_version: this.options.appVersion } : {}),
                            ...(this.options.platform ? { app_platform: this.options.platform } : {}), $process_person_profile: false, $geoip_disable: true },
                    }) }),
            });
            if (response.ok)
                await this.run(async () => {
                    if (generation !== this.generation[kind])
                        return;
                    const sent = new Set(batch.map(row => row.uuid));
                    this.state[kind] = this.state[kind].filter(row => !sent.has(row.uuid));
                    await this.persist();
                });
            await response.body?.cancel();
        }
        catch { /* Retry the same IDs later; never log payloads or response bodies. */ }
        finally {
            clearTimeout(timer);
            if (this.sending[kind] === controller)
                delete this.sending[kind];
        }
    }
    abort() { this.sending.usage?.abort(); this.sending.diagnostics?.abort(); }
}
exports.PrivacyClient = PrivacyClient;
