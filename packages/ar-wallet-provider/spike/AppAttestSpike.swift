// Throw-away App Attest spike for the Authrim wallet provider (stage W1). Not part of Keyring.
// Produces PUBLIC material only: key id, attestation object, assertions and the client data that was signed.
// Create a new iOS App project (SwiftUI) with bundle ID com.authrim.keyring.staging, team BQ23XXWDX8,
// capability "App Attest", replace the generated app/ContentView files with this file, run on a real iPhone.
import CryptoKit
import DeviceCheck
import SwiftUI
import UIKit

private func b64(_ data: Data) -> String { data.base64EncodedString() }
private func sha256(_ text: String) -> Data { Data(SHA256.hash(data: Data(text.utf8))) }

struct SpikeAssertion: Codable { let clientData: String; let assertion: String }
struct SpikeOutput: Codable {
    let bundleId: String
    let osVersion: String
    let deviceModel: String
    let label: String
    let keyId: String
    let registrationChallenge: String
    let attestationObject: String
    let assertions: [SpikeAssertion]
    let note: String
}

@MainActor
final class Spike: ObservableObject {
    @Published var status = "idle"
    @Published var json = ""

    func run(label: String) async {
        let service = DCAppAttestService.shared
        guard service.isSupported else { status = "App Attest not supported on this device"; return }
        do {
            status = "generating key"
            let keyId = try await service.generateKey()
            let regChallenge = "spike-registration-challenge-\(label)-1"
            status = "attesting"
            let attestation = try await service.attestKey(keyId, clientDataHash: sha256(regChallenge))
            // Three assertions, strictly increasing counters 1, 2, 3, over the contract's clientData shape (dummy thumbprint).
            let thumb = "SPIKE_THUMBPRINT_NOT_A_REAL_KEY"
            let datas = [
                "authrim-wallet-provider/v1\nwallet-attestation\nspike-assert-challenge-\(label)-1\n\(thumb)",
                "authrim-wallet-provider/v1\nkey-attestation\nspike-assert-challenge-\(label)-2\n\(thumb)\nspike-nonce-2",
                "authrim-wallet-provider/v1\nwallet-attestation\nspike-assert-challenge-\(label)-3\n\(thumb)",
            ]
            var assertions: [SpikeAssertion] = []
            for clientData in datas {
                status = "assertion \(assertions.count + 1)"
                let assertion = try await service.generateAssertion(keyId, clientDataHash: sha256(clientData))
                assertions.append(SpikeAssertion(clientData: clientData, assertion: b64(assertion)))
            }
            let out = SpikeOutput(
                bundleId: Bundle.main.bundleIdentifier ?? "?",
                osVersion: UIDevice.current.systemVersion,
                deviceModel: UIDevice.current.model,
                label: label,
                keyId: keyId,
                registrationChallenge: regChallenge,
                attestationObject: b64(attestation),
                assertions: assertions,
                note: "clientDataHash = SHA256(UTF-8(clientData)); registration clientDataHash = SHA256(UTF-8(registrationChallenge))")
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            json = String(data: try enc.encode(out), encoding: .utf8) ?? ""
            status = "done: copy the JSON"
        } catch { status = "error: \(error)" }
    }
}

@main
struct AppAttestSpikeApp: App {
    @StateObject private var spike = Spike()
    @State private var label = "run1"
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                TextField("label (e.g. dev, prod-entitlement)", text: $label).textFieldStyle(.roundedBorder)
                Button("Run spike") { Task { await spike.run(label: label) } }.buttonStyle(.borderedProminent)
                Text(spike.status).font(.footnote)
                Button("Copy JSON") { UIPasteboard.general.string = spike.json }.disabled(spike.json.isEmpty)
                ScrollView { Text(spike.json).font(.system(size: 9, design: .monospaced)).textSelection(.enabled) }
            }.padding()
        }
    }
}
