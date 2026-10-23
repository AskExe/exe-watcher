import { PLATFORMS } from './schema';
export type Consent = {
    usage: boolean;
    diagnostics: boolean;
};
export interface PrivateStorage {
    getItem(key: string): Promise<string | null>;
    /** Must replace atomically. Native adapters must use owner-only files/encrypted app storage. */
    setItem(key: string, value: string): Promise<void>;
}
export interface PrivacyOptions {
    app: string;
    /** Public gateway aliases, never PostHog admin tokens or a Sentry DSN. */
    usageAlias: string;
    diagnosticsAlias: string;
    features: readonly string[];
    appVersion?: string;
    platform?: typeof PLATFORMS[number];
    /** Static logical source names, registered in the gateway; never filesystem paths. */
    frames?: readonly string[];
    collector?: string;
    storage: PrivateStorage;
    /** Cryptographically random UUID provider (crypto.randomUUID, expo-crypto, etc.). */
    randomUUID: () => string;
    send?: typeof fetch;
    now?: () => number;
}
/** No SDK autocapture, user context, content strings, cookies, or provider fallback. */
export declare class PrivacyClient {
    private readonly options;
    private state;
    private serial;
    private generation;
    private sending;
    private readonly origin;
    private readonly key;
    private readonly now;
    private readonly features;
    private readonly frames;
    private constructor();
    static create(options: PrivacyOptions): Promise<PrivacyClient>;
    private binding;
    private fresh;
    private sanitize;
    private uuid;
    private run;
    private persist;
    status(): Consent;
    /** Call only after the app presents disclosure and records an explicit user choice. */
    setConsent(update: Partial<Consent>): Promise<boolean>;
    track(input: unknown): Promise<boolean>;
    report(input: unknown): Promise<boolean>;
    private enqueue;
    /** One bounded batch per channel; schedule retries in the app's lifecycle. */
    flush(): Promise<void>;
    private flushKind;
    abort(): void;
}
