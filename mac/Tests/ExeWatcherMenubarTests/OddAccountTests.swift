import Foundation
import Testing
@testable import ExeWatcherMenubar

@Suite("Odd account boundaries")
struct OddAccountTests {
    @Test func keychainBrokerRejectsUnrelatedItems() {
        #expect(OddKeychain.validKey("session"))
        #expect(OddKeychain.validKey("key:10000000-0000-4000-8000-000000000001"))
        #expect(!OddKeychain.validKey("npm-publish-token"))
        #expect(!OddKeychain.validKey("key:../../other-app"))
        #expect(!OddKeychain.validKey("key:"))
    }
    @Test func accountSecretsAreEncodedInTheInputPayload() throws {
        let request = OddAccountRequest(action: "enable", phrase: "fixture secret", confirm: true)
        let data = try JSONEncoder().encode(request)
        #expect(String(decoding: data, as: UTF8.self).contains("fixture secret"))
        let process = ExeWatcherCLI.makeProcess(subcommand: ["account", "--json"])
        #expect(!(process.arguments ?? []).joined().contains("fixture secret"))
    }
    @Test func boundedRunnerSendsInputWithoutShellArguments() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/cat")
        let bytes = Data("fixture-only-account-input".utf8)
        let (output, _, code) = try await CLIProcessRunner(process: process, timeout: 2, input: bytes).run()
        #expect(output == bytes)
        #expect(code == 0)
    }
}
