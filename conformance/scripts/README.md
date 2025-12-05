# OIDC Conformance Test Automation

A tool to automate OpenID Connect conformance testing for Authrim.
Executes tests against the [OpenID Conformance Suite](https://www.certification.openid.net) and collects the results.

## Overview

This tool automates the following:

1. **Test Plan Creation** - Creates test plans using the Conformance Suite API
2. **Test Execution** - Executes each test module sequentially
3. **Browser Automation** - Automatically handles login and consent flows using Playwright
4. **Automated Screenshot Capture** - Automatically captures and uploads required screens based on test specifications
5. **Result Collection** - Outputs test results in Markdown/JSON/HTML formats

## Quick Start

### 1. Setup

```bash
# Install dependencies in project root
pnpm install

# Install Playwright browsers
pnpm exec playwright install chromium
```

### 2. Obtaining API Token

1. Log in to https://www.certification.openid.net
2. Select 'API Tokens' from the account menu in the top right
3. Click 'Create Token' to generate a token
4. Copy the token to a secure location

### 3. Execution

```bash
# Set environment variable
export CONFORMANCE_TOKEN="your-api-token"

# Run Basic OP test
pnpm run conformance:basic

# Run with verbose logging
pnpm run conformance:basic -- --verbose

# Run with browser display mode (for debugging)
npx tsx conformance/scripts/run-conformance.ts --plan basic-op --show-browser
```

## Available Test Plans

| Key | Test Plan | Description |
|------|-------------|------|
| `basic-op` | OIDC Basic OP | Authorization Code Flow |
| `implicit-op` | OIDC Implicit OP | Implicit Flow |
| `hybrid-op` | OIDC Hybrid OP | Hybrid Flow |
| `config-op` | OIDC Config OP | Discovery / JWKS Test |
| `dynamic-op` | OIDC Dynamic OP | Dynamic Client Registration |
| `formpost-basic` | OIDC Form Post OP | Form Post + Authorization Code |
| `formpost-implicit` | OIDC Form Post Implicit OP | Form Post + Implicit Flow |
| `formpost-hybrid` | OIDC Form Post Hybrid OP | Form Post + Hybrid Flow |
| `rp-logout-op` | OIDC RP-Initiated Logout OP | Logout Functionality |
| `session-management-op` | OIDC Session Management OP | Session Management |
| `3rdparty-login-op` | OIDC 3rd Party Initiated Login OP | Third-Party Login |
| `fapi-2` | FAPI 2.0 Security Profile | Financial-grade API 2.0 |

## Screenshot Automation

### Overview

Some tests require uploading screenshots of error screens or re-authentication screens.
This tool automates screenshots with the following workflow:

1. **Test Specification Generation** - Pre-identifies required screenshots from the Plan API
2. **User Review** - Review and edit the generated specification
3. **Automated Capture** - Captures screenshots at specified times during test execution
4. **Automated Upload** - Uploads captured screenshots to the Conformance Suite

### Usage

```bash
# 1. Generate test specification
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json

# 2. Review test-spec.json and edit as needed
# (Adjust requiresScreenshot, screenshotTiming)

# 3. Run test with specification (automated screenshots)
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts \
  --plan basic-op \
  --spec ./test-spec.json

# 4. Manually upload screenshots (if needed)
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

### Screenshot Timing

| Timing | Description | Use Case |
|-----------|------|-----------|
| `on_error_page` | Error Page | Error display for invalid requests |
| `on_error_redirect` | Error Redirect | When error response is returned to callback |
| `on_login` | Initial Login Screen | Login screen display verification |
| `on_login_2nd` | Second Login Screen | Re-authentication with `prompt=login` |
| `on_login_3rd` | Third Login Screen | Tests requiring multiple authentications |
| `on_reauth` | Re-authentication Screen | Forced re-authentication with `max_age` |
| `on_consent` | Initial Consent Screen | Consent screen display verification |
| `on_consent_2nd` | Second Consent Screen | Re-consent with `prompt=consent` |
| `on_logout` | Logout Screen | Logout confirmation screen |
| `on_session_check` | Session Check | Session management iframe verification |
| `on_account_selection` | Account Selection Screen | `prompt=select_account` |
| `on_interaction` | User Interaction Screen | When `interaction_required` error occurs |
| `manual` | Manual Capture | Cases where automated capture is difficult |

For details, see [Test Specification Format](docs/test-spec-format.md).

## Command Line Options

### run-conformance.ts

```bash
npx tsx conformance/scripts/run-conformance.ts [options]
```

| Option | Description | Default |
|-----------|------|-----------|
| `--plan <name>` | Test plan key | `basic-op` |
| `--environment <env>` | Environment (`conformance`, `staging`, `local`) | `conformance` |
| `--spec <path>` | Test specification JSON file | - |
| `--show-browser` | Browser display mode | `false` |
| `--verbose` | Verbose log output | `false` |
| `--skip-profile-switch` | Skip profile switching | `false` |
| `--export-dir <path>` | Result output directory | `./conformance` |

### generate-test-spec.ts

```bash
npx tsx conformance/scripts/generate-test-spec.ts [options]
```

| Option | Description | Default |
|-----------|------|-----------|
| `--plan-name <name>` | Test plan key (required) | - |
| `--output <path>` | Output file path | `./test-spec.json` |

### check-image-placeholders.ts

```bash
npx tsx conformance/scripts/check-image-placeholders.ts [options]
```

| Option | Description |
|-----------|------|
| `--plan <planId>` | Check all tests in plan |
| `--module <moduleId>` | Check specific test |
| `--upload <imagePath>` | Upload image |
| `--placeholder <name>` | Target placeholder for upload |
| `--description <text>` | Image description |

## Environment Variables

| Variable | Required | Description |
|------|------|------|
| `CONFORMANCE_TOKEN` | ✅ | Conformance Suite API token |
| `CONFORMANCE_SERVER` | - | Conformance Suite URL (default: `https://www.certification.openid.net`) |
| `CONFORMANCE_TEST_EMAIL` | - | Test user email (default: `test@example.com`) |
| `CONFORMANCE_TEST_PASSWORD` | - | Test user password (default: `testpassword123`) |

## Configuration Files

### Test Plan Configuration

Each test plan's configuration is located in the `conformance/scripts/config/` directory:

```
config/
├── test-plans.json           # Test plan definitions (master)
├── basic-op.json             # Basic OP configuration
├── implicit-op.json          # Implicit OP configuration
├── hybrid-op.json            # Hybrid OP configuration
├── config-op.json            # Config OP configuration
├── dynamic-op.json           # Dynamic OP configuration
├── formpost-implicit-op.json # Form Post Implicit configuration
├── formpost-hybrid-op.json   # Form Post Hybrid configuration
├── rp-logout-op.json         # RP Logout configuration
├── session-management-op.json # Session Management configuration
├── 3rdparty-login-op.json    # 3rd Party Login configuration
└── fapi-2.json               # FAPI 2.0 configuration
```

### test-plans.json Structure

```json
{
  "plans": {
    "basic-op": {
      "name": "oidcc-basic-certification-test-plan",
      "displayName": "OIDC Basic OP Certification",
      "outputDir": "OIDC Basic OP",
      "profile": "basic-op",
      "configFile": "basic-op.json",
      "requiresBrowser": true,
      "variants": {
        "server_metadata": "discovery",
        "client_registration": "dynamic_client"
      }
    }
  },
  "environments": {
    "conformance": {
      "issuer": "https://conformance.authrim.com",
      "adminApiUrl": "https://conformance.authrim.com/api/admin"
    }
  }
}
```

## Output Files

Test results are saved for each execution in `conformance/{outputDir}/results/{timestamp}/`:

```
conformance/OIDC Basic OP/results/
└── 2025-11-26_153045/
    ├── run.log                       # Execution log (console output)
    ├── debug.log                     # Debug log (API details)
    ├── report.md                     # Markdown report
    ├── summary.json                  # JSON summary
    ├── plan-{planId}.html            # HTML report
    └── screenshots/                  # Screenshots
        ├── oidcc-server_login_2025-11-26T15-30-45.png
        └── oidcc-response-type-missing_error_2025-11-26T15-31-00.png
```

## Architecture

```
conformance/scripts/
├── run-conformance.ts          # Main entry point
├── generate-test-spec.ts       # Test specification generation
├── check-image-placeholders.ts # Image placeholder verification and upload
├── lib/
│   ├── types.ts                # Type definitions
│   ├── conformance-client.ts   # Conformance Suite API client
│   ├── browser-automator.ts    # Playwright browser automation
│   ├── profile-manager.ts      # Authrim profile management
│   ├── result-processor.ts     # Result processing and report generation
│   └── logger.ts               # Logging
├── config/
│   ├── test-plans.json         # Test plan definitions
│   ├── basic-op.json           # Configuration for each plan
│   └── ...
├── expected/
│   └── expected-failures.json  # Known failing tests
└── docs/
    ├── test-spec-format.md     # Test specification format documentation
    └── api-docs.json           # Conformance Suite API specification
```

### Processing Flow

```
┌─────────────────────────────────────────────────────────────────┐
│              Test Specification Generation (Pre-test)           │
│  generate-test-spec.ts                                         │
│  1. Create test plan (POST /api/plan)                          │
│  2. Retrieve plan details (GET /api/plan/{id}) - get testSummary │
│  3. Determine screenshot requirements/timing from testSummary   │
│  4. Output JSON specification                                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                     User Review and Editing
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Test Execution                             │
│  run-conformance.ts --spec test-spec.json                      │
│  1. Profile switching                                           │
│  2. Test plan creation                                          │
│  3. Execute each test module                                    │
│     - Browser authentication in WAITING state                   │
│     - Capture screenshots based on specification                │
│     - Detect placeholders → automatic upload                    │
│  4. Collect results and generate reports                        │
└─────────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### API Token Error

```
Error: 401 Unauthorized
```

→ Verify that `CONFORMANCE_TOKEN` is set correctly

### Screenshots Not Being Uploaded

1. Verify that `requiresScreenshot: true` is set in the test specification
2. Verify that `screenshotTiming` is properly configured
3. Check logs with the `--verbose` option

### Manually Uploading Screenshots

```bash
# Check placeholders
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId>

# Upload
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

### Browser Timeout

```
Error: Max attempts reached without completing authorization
```

→ Display browser with `--show-browser` to verify

### Test Stuck in WAITING State

- Browser automation may not be able to obtain authentication URL
- Check detailed logs with the `--verbose` option

## Reference Links

- [OpenID Conformance Suite](https://www.certification.openid.net)
- [Conformance Suite API Documentation](https://www.certification.openid.net/swagger-ui/index.html)
- [Conformance Suite Wiki](https://gitlab.com/openid/conformance-suite/-/wikis/home)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
