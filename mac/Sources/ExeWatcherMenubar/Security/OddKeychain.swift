import Foundation
import Security

/// The bundled CLI uses this mode through stdin/stdout. Never put a session, code or key in argv.
enum OddKeychain {
    static let service = "com.askexe.watcher.odd-account"

    static func validKey(_ key: String) -> Bool {
        key == "session" || (key.hasPrefix("key:") && UUID(uuidString: String(key.dropFirst(4))) != nil)
    }

    static func runBroker() -> Int32 {
        do {
            let input = try FileHandle.standardInput.read(upToCount: 16_385) ?? Data()
            guard input.count <= 16_384,
                  let request = try JSONSerialization.jsonObject(with: input) as? [String: String],
                  let action = request["action"], let key = request["key"], validKey(key),
                  Set(request.keys).isSubset(of: ["action", "key", "value"]) else { return fail() }
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                        kSecAttrService as String: service, kSecAttrAccount as String: key,
                                        kSecAttrSynchronizable as String: false]
            var value: String?
            switch action {
            case "get":
                var read = query
                read[kSecReturnData as String] = true
                read[kSecMatchLimit as String] = kSecMatchLimitOne
                var result: CFTypeRef?
                let status = SecItemCopyMatching(read as CFDictionary, &result)
                if status == errSecSuccess, let bytes = result as? Data {
                    guard bytes.count <= 16_384, let decoded = String(data: bytes, encoding: .utf8) else { return fail() }
                    value = decoded
                } else if status != errSecItemNotFound { return fail() }
            case "set":
                guard let text = request["value"], text.utf8.count <= 16_384 else { return fail() }
                let attributes: [String: Any] = [kSecValueData as String: Data(text.utf8)]
                let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
                if status == errSecItemNotFound {
                    var item = query
                    item[kSecValueData as String] = Data(text.utf8)
                    item[kSecAttrLabel as String] = "Watcher Odd account"
                    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { return fail() }
                } else if status != errSecSuccess { return fail() }
            case "remove":
                let status = SecItemDelete(query as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else { return fail() }
            default: return fail()
            }
            let response: [String: Any] = ["ok": true, "value": value as Any? ?? NSNull()]
            FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: response))
            return 0
        } catch { return fail() }
    }

    private static func fail() -> Int32 {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"value\":null}".utf8))
        return 1
    }
}
