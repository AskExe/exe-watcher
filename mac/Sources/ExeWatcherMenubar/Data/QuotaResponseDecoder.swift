import Foundation
import CoreFoundation

/// Schema mapping adapted from CodeBurn 9a40cc6, src/quota/{codex,kimi,cursor,
/// copilot,gemini}.ts (AgentSeal, MIT). Missing values never become zero.
enum QuotaResponseDecoder {
    static func decode(_ provider: QuotaProviderID, body: [String: Any], now: Date) throws -> ProviderQuotaSnapshot {
        var windows: [FloatingQuota.Window] = [], notes: [String] = [], plan: String?
        func window(_ id: String, _ label: String, _ percent: Double?, _ reset: Any?) -> FloatingQuota.Window? {
            guard let percent, percent.isFinite, percent >= 0 else { return nil }
            return .init(id: id, label: label, percent: min(100, percent), resetsAt: QuotaJSON.date(reset))
        }
        func ratio(_ row: [String: Any]?) -> Double? {
            guard let row, let limit = QuotaJSON.number(row["limit"]), limit > 0 else { return nil }
            if let used = QuotaJSON.number(row["used"]), used >= 0 { return used / limit * 100 }
            if let remaining = QuotaJSON.number(row["remaining"]), remaining >= 0 { return max(0, limit - remaining) / limit * 100 }
            return nil
        }
        switch provider {
        case .claude: throw ProviderQuotaFailure(kind: .unsupported)
        case .codex:
            plan = QuotaJSON.title(body["plan_type"])
            func rateWindow(_ value: Any?, id: String, prefix: String = "") -> FloatingQuota.Window? {
                guard let row = QuotaJSON.object(value) else { return nil }
                let seconds = QuotaJSON.number(row["limit_window_seconds"])
                let identity = prefix.isEmpty ? horizon(seconds) ?? id : id
                return window(identity, prefix + durationLabel(seconds), QuotaJSON.number(row["used_percent"]), row["reset_at"])
            }
            let rate = QuotaJSON.object(body["rate_limit"]) ?? [:]
            windows = [rateWindow(rate["primary_window"], id: "primary"), rateWindow(rate["secondary_window"], id: "secondary")].compactMap { $0 }
            for (index, raw) in (body["additional_rate_limits"] as? [[String: Any]] ?? []).prefix(8).enumerated() {
                guard let name = QuotaJSON.string(raw["limit_name"]), let rate = QuotaJSON.object(raw["rate_limit"]) else { continue }
                for key in ["primary_window", "secondary_window"] {
                    if let row = rateWindow(rate[key], id: "additional-\(index)-\(key)", prefix: String(name.prefix(160)) + " · ") { windows.append(row) }
                }
            }
            let spend = QuotaJSON.object(body["spend_control"]) ?? [:]
            let individual = QuotaJSON.object(spend["individual_limit"]) ?? QuotaJSON.object(spend["individualLimit"])
                ?? QuotaJSON.object(body["individual_limit"]) ?? QuotaJSON.object(body["individualLimit"])
                ?? QuotaJSON.object(rate["individual_limit"]) ?? QuotaJSON.object(rate["individualLimit"])
            if let individual, let limit = QuotaJSON.number(individual["limit"]), limit > 0 {
                let remaining = QuotaJSON.number(individual["remaining_percent"]) ?? QuotaJSON.number(individual["remainingPercent"])
                let percent = QuotaJSON.number(individual["used_percent"]) ?? QuotaJSON.number(individual["usedPercent"])
                    ?? remaining.map { 100 - $0 } ?? ratio(individual)
                if let row = window("monthly", "Monthly credit allowance", percent, individual["reset_at"] ?? individual["resets_at"] ?? individual["resetsAt"]) { windows.append(row) }
            }
            let credits = QuotaJSON.object(body["credits"]) ?? [:]
            if credits["unlimited"] as? Bool == true { notes.append("The provider reports unlimited credits.") }
        case .kimi:
            let user = QuotaJSON.object(body["user"]) ?? [:]
            plan = QuotaJSON.title(QuotaJSON.object(user["membership"])?["level"])?.replacingOccurrences(of: "Level ", with: "")
            func usageWindow(_ id: String, _ label: String, _ value: Any?) -> FloatingQuota.Window? {
                guard let row = QuotaJSON.object(value) else { return nil }
                return window(id, label, ratio(row), row["resetTime"] ?? row["resetAt"] ?? row["reset_time"] ?? row["reset_at"])
            }
            if let row = usageWindow("weekly", "Weekly", body["usage"]) { windows.append(row) }
            for (index, raw) in (body["limits"] as? [[String: Any]] ?? []).prefix(16).enumerated() {
                let span = QuotaJSON.object(raw["window"]) ?? [:]
                let count = QuotaJSON.number(span["duration"])
                let unit = QuotaJSON.string(span["timeUnit"])?.lowercased().replacingOccurrences(of: "time_unit_", with: "").trimmingCharacters(in: CharacterSet(charactersIn: "s"))
                let multiplier: Double? = ["minute": 60, "hour": 3600, "day": 86400, "week": 604800][unit ?? ""]
                let seconds = count.flatMap { c in multiplier.map { c * $0 } }
                if let row = usageWindow(horizon(seconds) ?? "limit-\(index)", durationLabel(seconds), raw["detail"]) { windows.append(row) }
            }
            if let parallel = QuotaJSON.number(QuotaJSON.object(body["parallel"])?["limit"]), parallel > 0 {
                notes.append("Parallel sessions: \(Int(min(parallel, 1_000_000)))")
            }
        case .cursor:
            plan = QuotaJSON.title(body["membershipType"])
            let individual = QuotaJSON.object(body["individualUsage"]) ?? [:]
            let quota = QuotaJSON.object(individual["plan"]) ?? [:]
            let team = QuotaJSON.object(body["teamUsage"]) ?? [:]
            let pool = QuotaJSON.object(team["pooled"]), onDemand = QuotaJSON.object(team["onDemand"])
            let auto = QuotaJSON.number(quota["autoPercentUsed"]), api = QuotaJSON.number(quota["apiPercentUsed"])
            let fallback = [auto, api].compactMap { $0 }.filter { $0 >= 0 }.max()
            let percent = QuotaJSON.number(quota["totalPercentUsed"]) ?? fallback ?? ratio(quota)
                ?? ratio(QuotaJSON.object(individual["overall"])) ?? ratio(pool)
            let teamOnDemand = onDemand?["enabled"] as? Bool == false ? nil : ratio(onDemand)
            if let row = window("monthly", percent == nil ? "Team on-demand" : "Monthly", percent ?? teamOnDemand, body["billingCycleEnd"]) { windows.append(row) }
            for (id, name, value) in [("auto", "Auto", auto), ("api", "API", api), ("pool", "Team pool", ratio(pool))] {
                if let row = window(id, name, value, body["billingCycleEnd"]) { windows.append(row) }
            }
            if let demand = QuotaJSON.object(individual["onDemand"]), demand["enabled"] as? Bool != false,
               let row = window("demand", "On-demand", ratio(demand), body["billingCycleEnd"]) { windows.append(row) }
            if body["isUnlimited"] as? Bool == true { notes.append("The provider reports an unlimited plan.") }
        case .copilot:
            plan = QuotaJSON.title(body["copilot_plan"] ?? body["copilotPlan"])
            let snapshots = QuotaJSON.object(body["quota_snapshots"] ?? body["quotaSnapshots"]) ?? [:]
            let reset = body["quota_reset_date_utc"] ?? body["quota_reset_date"] ?? body["quotaResetDate"]
            for (id, label, raw) in [("premium", "Premium allowance", snapshots["premium_interactions"] ?? snapshots["premiumInteractions"]), ("chat", "Chat", snapshots["chat"])] {
                guard let row = QuotaJSON.object(raw) else { continue }
                if row["unlimited"] as? Bool == true { notes.append(label + ": unlimited"); continue }
                if QuotaJSON.number(row["entitlement"]) == 0 { notes.append(label + ": not included"); continue }
                let remaining = QuotaJSON.number(row["percent_remaining"] ?? row["percentRemaining"])
                if let remaining, remaining >= 0, remaining <= 100,
                   let value = window(id, label, 100 - remaining, reset) { windows.append(value) }
            }
        case .gemini:
            for (index, bucket) in (body["buckets"] as? [[String: Any]] ?? []).prefix(128).enumerated() {
                guard let name = QuotaJSON.string(bucket["modelId"]), let remaining = QuotaJSON.number(bucket["remainingFraction"]),
                      remaining >= 0, remaining <= 1 else { continue }
                if let row = window("bucket-\(index)", String(name.prefix(160)), (1 - remaining) * 100, bucket["resetTime"]) { windows.append(row) }
            }
            windows.sort { $0.percent > $1.percent }
        }
        guard !windows.isEmpty || !notes.isEmpty else { throw ProviderQuotaFailure(kind: .invalidResponse) }
        // Keep duplicate provider window identities unique without discarding their readings.
        var seen = Set<String>()
        windows = windows.enumerated().map { index, row in
            let id = seen.insert(row.id).inserted ? row.id : row.id + "-\(index)"
            return .init(id: id, label: row.label, percent: row.percent, resetsAt: row.resetsAt)
        }
        return ProviderQuotaSnapshot(provider: provider, plan: plan, windows: Array(windows.prefix(24)), fetchedAt: now, notes: notes)
    }

    private static func horizon(_ seconds: Double?) -> String? {
        guard let seconds else { return nil }
        if abs(seconds - 18_000) < 1 { return "fiveHour" }
        if abs(seconds - 604_800) < 1 { return "weekly" }
        return nil
    }
    private static func durationLabel(_ seconds: Double?) -> String {
        guard let seconds, seconds > 0, seconds < 31_536_000 else { return "Usage window" }
        if abs(seconds - 604_800) < 1 { return "Weekly" }
        if abs(seconds - 86_400) < 1 { return "Daily" }
        if seconds < 3600 { return "\(max(1, Int(seconds / 60)))-minute" }
        if seconds < 86400 { return "\(Int(seconds / 3600))-hour" }
        return "\(Int(seconds / 86400))-day"
    }
}

enum QuotaJSON {
    static func object(_ value: Any?) -> [String: Any]? { value as? [String: Any] }
    static func string(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let clean = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }
    static func title(_ value: Any?) -> String? { string(value).map { String($0.prefix(160)).replacingOccurrences(of: "_", with: " ").capitalized } }
    static func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber {
            guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
            return number.doubleValue
        }
        if let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let number = Double(text), number.isFinite { return number }
        return nil
    }
    static func date(_ value: Any?) -> Date? {
        if let seconds = number(value), seconds > 0, seconds < 8_640_000_000_000 {
            return Date(timeIntervalSince1970: seconds > 1_000_000_000_000 ? seconds / 1000 : seconds)
        }
        guard let text = value as? String else { return nil }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: text) { return date }
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: text) { return date }
        let day = DateFormatter(); day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = TimeZone(secondsFromGMT: 0); day.dateFormat = "yyyy-MM-dd"
        return day.date(from: text)
    }
}
