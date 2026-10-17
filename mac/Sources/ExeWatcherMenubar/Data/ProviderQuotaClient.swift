import Foundation
import CryptoKit
import Security
import LocalAuthentication
import SQLite3

/// Read-only adapters informed by CodeBurn 9a40cc6 (MIT). No token refresh or
/// credential write-back is imported. See THIRD_PARTY_NOTICES.md.
struct ProviderQuotaClient {
    struct Dependencies: Sendable {
        let home: URL
        let environment: [String: String]
        let now: @Sendable () -> Date
        let readFile: @Sendable (URL, Int) throws -> Data?
        let readKeychain: @Sendable (String, String, Bool) throws -> Data?
        let cursorToken: @Sendable (URL) throws -> String?
        let request: @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)
        static var live: Self {
            Self(home: FileManager.default.homeDirectoryForCurrentUser, environment: ProcessInfo.processInfo.environment,
                now: Date.init, readFile: readCredential, readKeychain: keychainCredential,
                cursorToken: cursorAccessToken, request: QuotaHTTP.request)
        }
    }

    static func fetch(_ provider: QuotaProviderID, allowKeychainPrompt: Bool = false,
                      dependencies d: Dependencies = .live) async throws -> ProviderQuotaSnapshot {
        var identity: String?
        do {
            let credential = try credentials(provider, prompt: allowKeychainPrompt, dependencies: d)
            identity = credential.identity
            var body: [String: Any] = [:]
            var assist: [String: Any] = [:]
            if provider == .gemini {
                assist = try await request(credential, url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
                    payload: ["metadata": ["ideType": "GEMINI_CLI", "pluginType": "GEMINI"]], dependencies: d)
                let project = QuotaJSON.string(assist["cloudaicompanionProject"])
                body = try await request(credential, url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
                    payload: project.map { ["project": $0] } ?? [:], dependencies: d)
            } else {
                body = try await request(credential, url: credential.endpoint, dependencies: d)
            }
            var result = try QuotaResponseDecoder.decode(provider, body: body, now: d.now())
            if provider == .gemini {
                let tier = QuotaJSON.object(assist["paidTier"]) ?? QuotaJSON.object(assist["currentTier"]) ?? [:]
                result.plan = QuotaJSON.string(tier["name"]) ?? QuotaJSON.string(tier["id"])
            }
            result.identity = credential.identity
            return result
        } catch var failure as ProviderQuotaFailure {
            failure.identity = identity ?? failure.identity
            throw failure
        } catch is CancellationError { throw CancellationError()
        } catch {
            if Task.isCancelled { throw CancellationError() }
            // Never propagate provider response bodies, token-bearing URLs or file contents.
            throw ProviderQuotaFailure(kind: .unavailable, identity: identity)
        }
    }

    struct Credential {
        let endpoint: String
        let headers: [String: String]
        let identity: String
    }

    private static func credentials(_ provider: QuotaProviderID, prompt: Bool, dependencies d: Dependencies) throws -> Credential {
        func file(_ relative: String, base: URL? = nil) throws -> [String: Any]? {
            guard let data = try d.readFile((base ?? d.home).appendingPathComponent(relative), 64 * 1024) else { return nil }
            guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                throw ProviderQuotaFailure(kind: .signIn)
            }
            return object
        }
        func bearer(_ token: String?, endpoint: String, account: String? = nil, headers: [String: String] = [:]) throws -> Credential {
            guard let token = validToken(token) else { throw ProviderQuotaFailure(kind: .missing) }
            let identity = fingerprint(provider.rawValue + ":" + (account ?? token))
            if let expiry = QuotaJSON.number(jwtClaims(token)["exp"]), expiry <= d.now().timeIntervalSince1970 + 60 {
                throw ProviderQuotaFailure(kind: .signIn, identity: identity)
            }
            return Credential(endpoint: endpoint, headers: headers.merging(["Authorization": "Bearer \(token)"]) { _, new in new }, identity: identity)
        }
        switch provider {
        case .claude: throw ProviderQuotaFailure(kind: .unsupported) // AppStore reuses the existing Claude/Plan reader.
        case .codex:
            let base = directory("CODEX_HOME", fallback: d.home.appendingPathComponent(".codex"), environment: d.environment)
            let configData = try d.readFile(base.appendingPathComponent("config.toml"), 256 * 1024)
            let config = configData.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let mode = configValue("cli_auth_credentials_store", in: config)
            if let gateway = configValue("chatgpt_base_url", in: config),
               !["https://chatgpt.com", "https://chatgpt.com/backend-api"].contains(gateway.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) {
                throw ProviderQuotaFailure(kind: .unsupported, message: "Custom Codex gateways are not supported by this quota reader.")
            }
            guard mode != "ephemeral" else { throw ProviderQuotaFailure(kind: .missing) }
            func keychain() throws -> [String: Any]? {
                let path = canonicalPath(base.path)
                let account = "cli|" + String(fingerprint(path).prefix(16))
                guard let data = try d.readKeychain("Codex Auth", account, prompt), data.count <= 64 * 1024 else { return nil }
                guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw ProviderQuotaFailure(kind: .signIn) }
                return object
            }
            let root: [String: Any]?
            if mode == "keyring" { root = try keychain() }
            else if mode == "auto" { root = try keychain() ?? file("auth.json", base: base) }
            else { root = try file("auth.json", base: base) ?? (mode == nil ? keychain() : nil) }
            guard let root else { throw ProviderQuotaFailure(kind: .missing) }
            if let mode = QuotaJSON.string(root["auth_mode"]), mode != "chatgpt" {
                throw ProviderQuotaFailure(kind: .unsupported, message: "Codex subscription quota requires a ChatGPT sign-in.")
            }
            if QuotaJSON.string(root["auth_mode"]) == nil, QuotaJSON.string(root["OPENAI_API_KEY"]) != nil {
                throw ProviderQuotaFailure(kind: .unsupported, message: "Codex subscription quota requires a ChatGPT sign-in.")
            }
            let tokens = QuotaJSON.object(root["tokens"]) ?? [:]
            let access = QuotaJSON.string(tokens["access_token"])
            let claims = jwtClaims(QuotaJSON.string(tokens["id_token"]) ?? access ?? "")
            let auth = QuotaJSON.object(claims["https://api.openai.com/auth"]) ?? [:]
            let account = QuotaJSON.string(tokens["account_id"]) ?? QuotaJSON.string(auth["chatgpt_account_id"])
            if let account, validToken(account) == nil || account.utf8.count > 256 { throw ProviderQuotaFailure(kind: .signIn) }
            return try bearer(access, endpoint: "https://chatgpt.com/backend-api/wham/usage", account: account,
                headers: account.map { ["ChatGPT-Account-Id": $0] } ?? [:])
        case .kimi:
            let base = directory("KIMI_CODE_HOME", fallback: d.home.appendingPathComponent(".kimi-code"), environment: d.environment)
            guard let root = try file("credentials/kimi-code.json", base: base),
                  let token = validToken(QuotaJSON.string(root["access_token"])) else { throw ProviderQuotaFailure(kind: .missing) }
            let identity = fingerprint(provider.rawValue + ":" + token)
            guard let expiry = QuotaJSON.number(root["expires_at"]), expiry > d.now().timeIntervalSince1970 + 60 else {
                throw ProviderQuotaFailure(kind: .signIn, identity: identity)
            }
            var headers = ["X-Msh-Platform": "kimi_code_cli"]
            if let data = try? d.readFile(base.appendingPathComponent("device_id"), 4096),
               let device = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               let valid = validToken(device) { headers["X-Msh-Device-Id"] = valid }
            return try bearer(token, endpoint: "https://api.kimi.com/coding/v1/usages", headers: headers)
        case .cursor:
            let url = d.home.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/state.vscdb")
            guard let token = try d.cursorToken(url), let valid = validToken(token) else { throw ProviderQuotaFailure(kind: .missing) }
            let claims = jwtClaims(valid)
            guard valid.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
                  let subject = QuotaJSON.string(claims["sub"])?.split(separator: "|").last.map(String.init),
                  subject.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
                  let expiry = QuotaJSON.number(claims["exp"]), expiry > d.now().timeIntervalSince1970 + 60 else {
                throw ProviderQuotaFailure(kind: .signIn)
            }
            return Credential(endpoint: "https://cursor.com/api/usage-summary",
                headers: ["Cookie": "WorkosCursorSessionToken=\(subject)%3A%3A\(valid)"], identity: fingerprint("cursor:" + subject))
        case .copilot:
            let root = directory("XDG_CONFIG_HOME", fallback: d.home.appendingPathComponent(".config"), environment: d.environment)
            for name in ["hosts.json", "apps.json"] {
                guard let map = try file("github-copilot/" + name, base: root) else { continue }
                let entries = map.keys.sorted().compactMap { key -> (String, String)? in
                    guard let token = validToken(QuotaJSON.string(QuotaJSON.object(map[key])?["oauth_token"])) else { return nil }
                    let host: String
                    if name == "apps.json" {
                        guard let separator = key.firstIndex(of: ":") else { return nil }
                        host = String(key[..<separator])
                    } else { host = key }
                    return (host.lowercased(), token)
                }
                if entries.isEmpty, map.values.contains(where: { validToken(QuotaJSON.string(QuotaJSON.object($0)?["oauth_token"])) != nil }) {
                    throw ProviderQuotaFailure(kind: .unsupported, message: "Copilot sign-in does not identify its GitHub host. Update or sign in again through the editor plugin, then refresh.")
                }
                guard let entry = entries.first(where: { $0.0 == "github.com" }) ?? entries.first(where: { copilotAPIHost($0.0) != nil }) ?? entries.first else { continue }
                guard let host = copilotAPIHost(entry.0) else {
                    throw ProviderQuotaFailure(kind: .unsupported, message: "This Copilot host is unsupported. GitHub.com and Enterprise Cloud (*.ghe.com) are supported.")
                }
                return Credential(endpoint: "https://\(host)/copilot_internal/user",
                    headers: ["Authorization": "token \(entry.1)", "Editor-Version": "vscode/1.96.2",
                              "Editor-Plugin-Version": "copilot-chat/0.26.7", "X-Github-Api-Version": "2025-04-01"],
                    identity: fingerprint("copilot:" + entry.0 + ":" + entry.1))
            }
            throw ProviderQuotaFailure(kind: .missing)
        case .gemini:
            guard let root = try file(".gemini/oauth_creds.json") else { throw ProviderQuotaFailure(kind: .missing) }
            if let expiry = QuotaJSON.number(root["expiry_date"]), expiry / 1000 <= d.now().timeIntervalSince1970 + 60 {
                throw ProviderQuotaFailure(kind: .signIn)
            }
            return try bearer(QuotaJSON.string(root["access_token"]), endpoint: "")
        }
    }

    private static func request(_ credential: Credential, url: String, payload: [String: Any]? = nil,
                                dependencies d: Dependencies) async throws -> [String: Any] {
        guard let endpoint = URL(string: url), endpoint.scheme == "https", endpoint.user == nil, endpoint.password == nil else {
            throw ProviderQuotaFailure(kind: .unsupported)
        }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Watcher", forHTTPHeaderField: "User-Agent")
        for (key, value) in credential.headers { request.setValue(value, forHTTPHeaderField: key) }
        if let payload {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        }
        let (data, response) = try await d.request(request)
        try Task.checkCancellation()
        if response.statusCode == 401 || response.statusCode == 403 { throw ProviderQuotaFailure(kind: .signIn) }
        if response.statusCode == 429 {
            throw ProviderQuotaFailure(kind: .rateLimited, retryAfter: retryAfter(response.value(forHTTPHeaderField: "Retry-After"), now: d.now()))
        }
        guard response.statusCode == 200 else { throw ProviderQuotaFailure(kind: .unavailable) }
        guard data.count <= 512 * 1024, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProviderQuotaFailure(kind: .invalidResponse)
        }
        return object
    }

    static func retryAfter(_ text: String?, now: Date) -> TimeInterval {
        if let text, let seconds = Double(text), seconds.isFinite { return max(900, min(86_400, seconds)) }
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(secondsFromGMT: 0); format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return text.flatMap(format.date).map { max(900, min(86_400, $0.timeIntervalSince(now))) } ?? 900
    }
    static func copilotAPIHost(_ host: String) -> String? {
        guard host.range(of: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$", options: .regularExpression) != nil else { return nil }
        if host == "github.com" || host == "api.github.com" { return "api.github.com" }
        guard host.hasSuffix(".ghe.com"), host != "ghe.com" else { return nil }
        return host.hasPrefix("api.") ? host : "api." + host
    }
    static func jwtClaims(_ token: String) -> [String: Any] {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return [:] }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload), data.count <= 64 * 1024 else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
    static func fingerprint(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func validToken(_ value: String?) -> String? {
        guard let token = value?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty, token.utf8.count <= 64 * 1024,
              !token.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespaces.contains($0) }) else { return nil }
        return token
    }
    private static func canonicalPath(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }
    private static func directory(_ key: String, fallback: URL, environment: [String: String]) -> URL {
        guard let path = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines), path.hasPrefix("/") else { return fallback }
        return URL(fileURLWithPath: path)
    }
    private static func configValue(_ key: String, in config: String) -> String? {
        // Only root TOML keys apply; stop at the first table so a provider section cannot override auth routing.
        let root = config.components(separatedBy: .newlines).prefix { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("[") }.joined(separator: "\n")
        guard let regex = try? NSRegularExpression(pattern: "(?m)^\\s*" + key + "\\s*=\\s*[\"']([^\"']+)[\"']"),
              let match = regex.firstMatch(in: root, range: NSRange(root.startIndex..., in: root)),
              let range = Range(match.range(at: 1), in: root) else { return nil }
        return String(root[range])
    }

    static func readCredential(_ url: URL, limit: Int) throws -> Data? {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard descriptor >= 0 else {
            if errno == ENOENT { return nil }
            throw ProviderQuotaFailure(kind: .unavailable)
        }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= limit else {
            throw ProviderQuotaFailure(kind: .unavailable)
        }
        var output = Data(), buffer = [UInt8](repeating: 0, count: min(limit + 1, 8192))
        while true {
            let count = Darwin.read(descriptor, &buffer, buffer.count)
            if count == 0 { return output }
            if count < 0 { if errno == EINTR { continue }; throw ProviderQuotaFailure(kind: .unavailable) }
            guard output.count + count <= limit else { throw ProviderQuotaFailure(kind: .unavailable) }
            output.append(contentsOf: buffer.prefix(count))
        }
    }
    private static func keychainCredential(_ service: String, account: String, prompt: Bool) throws -> Data? {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecMatchLimit as String: kSecMatchLimitOne, kSecReturnData as String: true]
        if !prompt { let context = LAContext(); context.interactionNotAllowed = true; query[kSecUseAuthenticationContext as String] = context }
        var output: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &output)
        if status == errSecItemNotFound { return nil }
        if status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled {
            // Auto mode must not substitute an older file account when the active
            // Keychain item exists but cannot be read without user interaction.
            throw ProviderQuotaFailure(kind: .signIn, message: "Codex Keychain access is unavailable. Use Refresh to allow read access, then try again.")
        }
        guard status == errSecSuccess, let data = output as? Data, data.count <= 64 * 1024 else { throw ProviderQuotaFailure(kind: .unavailable) }
        return data
    }
    static func cursorAccessToken(_ url: URL) throws -> String? {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { if errno == ENOENT { return nil }; throw ProviderQuotaFailure(kind: .unavailable) }
        guard (info.st_mode & S_IFMT) == S_IFREG else { throw ProviderQuotaFailure(kind: .unavailable) }
        var database: OpaquePointer?
        // SQLite NOFOLLOW rejects ancestor aliases such as macOS /var -> /private/var.
        // Resolve the parent only; the final file must still pass NOFOLLOW.
        let databasePath = canonicalPath(url.deletingLastPathComponent().path) + "/" + url.lastPathComponent
        let status = sqlite3_open_v2(databasePath, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX | SQLITE_OPEN_NOFOLLOW, nil)
        defer { if let database { sqlite3_close(database) } }
        guard status == SQLITE_OK, let database else { throw ProviderQuotaFailure(kind: .unavailable) }
        sqlite3_busy_timeout(database, 100)
        sqlite3_limit(database, SQLITE_LIMIT_LENGTH, 64 * 1024)
        sqlite3_progress_handler(database, 100_000, { _ in 1 }, nil)
        var statement: OpaquePointer?
        defer { sqlite3_finalize(statement) }
        guard sqlite3_prepare_v2(database, "SELECT CAST(value AS BLOB) FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1", -1, &statement, nil) == SQLITE_OK else { throw ProviderQuotaFailure(kind: .unavailable) }
        let step = sqlite3_step(statement)
        if step == SQLITE_DONE { return nil }
        guard step == SQLITE_ROW, let pointer = sqlite3_column_blob(statement, 0) else { throw ProviderQuotaFailure(kind: .unavailable) }
        let count = Int(sqlite3_column_bytes(statement, 0))
        guard count <= 64 * 1024 else { throw ProviderQuotaFailure(kind: .unavailable) }
        return String(data: Data(bytes: pointer, count: count), encoding: .utf8)
    }
}

/// Credentials never follow redirects and no request can persist cookies or cache bodies.
enum QuotaHTTP {
    final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
    }
    static func request(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 25
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, response.expectedContentLength <= 512 * 1024 else { throw ProviderQuotaFailure(kind: .invalidResponse) }
        var output = Data()
        for try await byte in bytes {
            guard output.count < 512 * 1024 else { throw ProviderQuotaFailure(kind: .invalidResponse) }
            output.append(byte)
        }
        return (output, http)
    }
}
