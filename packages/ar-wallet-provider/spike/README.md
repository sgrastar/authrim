# App Attest device spike (W1)

Purpose: capture real Apple App Attest output so the provider's verifiers are built against Apple, not against our own generated vectors
(design `20261125-authrim-wallet-provider-service.md`, §13/§14, W1). Public material only; nothing here is a secret.

What to do (about 15 minutes, a real iPhone, not the simulator):

1. Xcode: File > New > Project > iOS App (SwiftUI). Product name `AppAttestSpike`, Team `BQ23XXWDX8`, bundle ID `com.authrim.keyring.staging`.
2. Signing & Capabilities: add **App Attest**. Replace the generated `*App.swift` and `ContentView.swift` content with `AppAttestSpike.swift` (delete the other files' `@main`).
3. **Run 1 (development environment):** run from Xcode on the iPhone, enter label `dev`, tap _Run spike_, tap _Copy JSON_, save the text as `spike-dev.json`.
4. **Run 2 (production environment from a development-signed build):** in the entitlements file set
   `com.apple.developer.devicecheck.appattest-environment` = `production`, run again from Xcode, label `prod-entitlement`, save as `spike-prod-entitlement.json`.
5. Optional but valuable (W5 can do it later): upload the same app to TestFlight, install it, run once with label `testflight`, save `spike-testflight.json`.
6. Send me the JSON files (paste or file path), plus the iOS version of the phone (the JSON has it).

Do not reuse a spike key anywhere else; the app generates a fresh App Attest key each run (one run = one key = counters 1, 2, 3).
