/** MIT. Counters and structural errors only; never forward caller property bags. */
export declare const DEFAULT_COLLECTOR = "https://data.odd.community";
export declare const HANSEL_FEATURES: readonly ["home", "recordings", "vocabulary", "shortcuts", "dictation"];
export declare const ERROR_CATEGORIES: readonly ["crash", "unhandled_exception", "render_error", "ipc_error", "ml_error"];
export declare const DEFAULT_FRAMES: readonly ["app:///main/index.js", "app:///renderer/index.js"];
export declare const USAGE_DISCLOSURE = "Share active time, recording duration, feature counts and outcomes, app version and platform with our own servers. A random ID unique to this app measures returning installations. Never audio, transcripts, prompts, account details or screen recordings.";
export declare const DIAGNOSTICS_DISCLOSURE = "Share sanitized error categories, app version and code locations with our own Sentry server. Never error text, account details, recordings or memory dumps.";
export declare const PLATFORMS: readonly ["macos", "windows", "linux", "ios", "android", "web"];
export type Metric = {
    event: 'active';
} | {
    event: 'usage';
    active_ms: number;
} | {
    event: 'recording';
    recording_ms: number;
} | {
    event: 'feature';
    feature: string;
} | {
    event: 'result';
    feature: string;
    outcome: 'success' | 'failure';
};
export type Diagnostic = {
    event: 'error';
    category: typeof ERROR_CATEGORIES[number];
    error_class: string;
    version: string;
    frames: {
        filename: string;
        lineno: number;
        colno: number;
    }[];
};
export declare const UUID: RegExp;
export declare function record(input: unknown): Record<string, unknown> | null;
export declare function sanitizeMetric(input: unknown, features?: readonly string[]): Metric | null;
export declare function sanitizeDiagnostic(input: unknown, allowedFrames?: readonly string[]): Diagnostic | null;
export declare function collectorOrigin(input: string): string;
/** Sample with a monotonic clock; reset at consent/focus lifecycle boundaries. */
export declare class ActiveClock {
    private previous;
    sample(time: number, focused: boolean, idleSeconds: number, recording?: boolean): number;
    reset(): void;
}
