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

    @MainActor @Test(arguments: [false, true], [false, true])
    func emailCodeFlowRequiresPoliciesAndVerificationPermission(createAccount: Bool, optIn: Bool) async throws {
        var requests: [OddAccountRequest] = []
        let model = OddAccountModel { request in
            requests.append(request)
            switch request.action {
            case "verifyCode", "status":
                return OddAccountReply(ok: true, signedIn: true, email: request.email ?? "person@example.test", backupEnabled: false)
            default:
                return OddAccountReply(ok: true)
            }
        }
        model.createAccount = createAccount
        model.email = "  person@example.test  "
        #expect(!model.acceptTerms)
        #expect(!model.acceptVerificationEmail)
        #expect(!model.acceptEmailCommunications)
        #expect(!model.canRequestCode)
        await model.requestCode()

        model.acceptTerms = true
        await model.requestCode()
        model.acceptTerms = false
        model.acceptVerificationEmail = true
        await model.requestCode()
        #expect(requests.isEmpty)

        model.acceptTerms = true
        model.email = "invalid"
        #expect(!model.acceptVerificationEmail)
        model.acceptVerificationEmail = true
        #expect(!model.canRequestCode)
        await model.requestCode()
        #expect(requests.isEmpty)

        model.email = "  person@example.test  "
        model.acceptVerificationEmail = true
        model.acceptEmailCommunications = optIn
        #expect(model.canRequestCode)
        await model.requestCode()
        #expect(model.codeSent)
        model.code = "123456"
        await model.requestCode()
        #expect(model.code.isEmpty)
        #expect(requests.count == 2)
        for request in requests {
            #expect(request.action == "requestCode")
            #expect(request.email == "person@example.test")
            #expect(request.createAccount == createAccount)
            #expect(request.acceptTerms == true)
            #expect(request.acceptVerificationEmail == true)
            #expect(request.acceptEmailCommunications == nil)
        }

        model.code = "123abc"
        #expect(!model.canVerifyCode)
        await model.verifyCode()
        #expect(requests.count == 2)
        model.code = " 123456 "
        #expect(model.canVerifyCode)
        await model.verifyCode()
        #expect(requests.map(\.action) == ["requestCode", "requestCode", "verifyCode", "status"])
        #expect(requests.first { $0.action == "verifyCode" }?.code == "123456")
        #expect(requests.first { $0.action == "verifyCode" }?.acceptEmailCommunications == optIn)
        #expect(model.signedIn)
        #expect(!model.codeSent)
        #expect(model.code.isEmpty)
        #expect(!model.backupEnabled)
    }

    @MainActor @Test
    func verificationConsentIsClearedWhenChangingEmailOrStartingOver() async {
        let model = OddAccountModel { _ in OddAccountReply(ok: true) }
        model.email = "first@example.test"
        model.acceptTerms = true
        model.acceptVerificationEmail = true
        model.acceptEmailCommunications = true
        await model.requestCode()
        model.code = "123456"

        model.email = "second@example.test"
        #expect(!model.acceptVerificationEmail)
        #expect(!model.acceptEmailCommunications)
        #expect(!model.codeSent)
        #expect(model.code.isEmpty)
        #expect(!model.canRequestCode)

        model.acceptVerificationEmail = true
        model.acceptEmailCommunications = true
        await model.requestCode()
        model.restartSignIn()
        #expect(!model.acceptTerms)
        #expect(!model.acceptVerificationEmail)
        #expect(!model.acceptEmailCommunications)
        #expect(!model.codeSent)
        #expect(!model.canRequestCode)
    }

    @MainActor @Test
    func verificationLayoutPreviewShowsTheCodeStep() {
        let model = OddAccountModel.layoutPreview("verification")
        #expect(model.codeSent)
        #expect(model.canRequestCode)
    }
}
