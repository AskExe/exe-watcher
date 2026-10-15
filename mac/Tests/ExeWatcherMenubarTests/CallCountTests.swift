import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Call count coverage")
struct CallCountTests {
    @Test("unknown, partial and recorded counts have distinct labels")
    func labels() {
        #expect(CallCount(recorded: 0, isIncomplete: true).displayValue == "—")
        #expect(CallCount(recorded: 18, isIncomplete: true).displayValue == "18+")
        #expect(CallCount(recorded: 10466, isIncomplete: false).displayValue == "10,466")
        #expect(CallCount(recorded: 0, isIncomplete: false).displayValue == "0")
    }

    private func payload(coverage: Bool?) throws -> MenubarPayload {
        let data = try JSONEncoder().encode(MenubarPayload.empty)
        var json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var current = try #require(json["current"] as? [String: Any])
        current["cost"] = 34002
        current["calls"] = 21
        var partial: [String: Any] = ["name": "Opus 4.6", "cost": 34000, "calls": 18]
        var unknown: [String: Any] = ["name": "Opus 4.8", "cost": 2, "calls": 0]
        var complete: [String: Any] = ["name": "GPT-5.4", "cost": 0, "calls": 3]
        if let coverage {
            current["callsIncomplete"] = coverage
            partial["callsIncomplete"] = coverage
            unknown["callsIncomplete"] = coverage
            complete["callsIncomplete"] = false
        }
        current["topModels"] = [partial, unknown, complete]
        json["current"] = current
        json["diagnostics"] = ["daysCount": 1, "parseTimeMs": 0,
                               "warnings": ["Includes historical Claude token counters missing from retained transcripts."]]
        return try JSONDecoder().decode(MenubarPayload.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test("CLI coverage survives decoding and persistence without marking complete models partial")
    func roundTrip() throws {
        let original = try payload(coverage: true)
        let decoded = try JSONDecoder().decode(MenubarPayload.self, from: JSONEncoder().encode(original))
        #expect(decoded.callCount.displayValue == "21+")
        #expect(decoded.callCount(for: decoded.current.topModels[0]).displayValue == "18+")
        #expect(decoded.callCount(for: decoded.current.topModels[1]).displayValue == "—")
        #expect(decoded.callCount(for: decoded.current.topModels[2]).displayValue == "3")
    }

    @Test("legacy cached history does not present missing counts as exact numbers")
    func legacySnapshot() throws {
        let decoded = try payload(coverage: nil)
        #expect(decoded.callCount.displayValue == "21+")
        #expect(decoded.callCount(for: decoded.current.topModels[0]).displayValue == "18+")
        #expect(decoded.callCount(for: decoded.current.topModels[1]).displayValue == "—")
    }

    @Test("explicit complete coverage overrides the legacy recovery warning")
    func completeCoverage() throws {
        let decoded = try payload(coverage: false)
        #expect(decoded.callCount.displayValue == "21")
        #expect(decoded.callCount(for: decoded.current.topModels[0]).displayValue == "18")
        #expect(decoded.callCount(for: decoded.current.topModels[1]).displayValue == "0")
        #expect(MenubarPayload.empty.callCount.displayValue == "0")
    }
}
