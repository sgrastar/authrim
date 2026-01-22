# Translation Status

This file tracks the progress of translating the project to English.

## Status Legend

| Status       | Description                                |
| ------------ | ------------------------------------------ |
| Untranslated | Contains Japanese text or not yet reviewed |
| Translated   | English conversion completed               |
| N/A          | English only file (no translation needed)  |

## Check Legend

| Symbol | Description     |
| ------ | --------------- |
| `-`    | Not yet checked |
| `✅`   | Check completed |

---

## Summary

| Category          | Total   | Untranslated | Translated | N/A    |
| ----------------- | ------- | ------------ | ---------- | ------ |
| Source Code       | 472     | 418          | 32         | 22     |
| Documentation     | 107     | 97           | 9          | 1      |
| Scripts           | 31      | 28           | 3          | 0      |
| Conformance Tests | 86      | 84           | 1          | 1      |
| Load Testing      | 19      | 19           | 0          | 0      |
| E2E Tests         | 5       | 5            | 0          | 0      |
| Root Files        | 7       | 7            | 0          | 0      |
| Claude Skills     | 31      | 31           | 0          | 0      |
| **Total**         | **758** | **689**      | **45**     | **24** |

---

## 1. Source Code (packages/\*/src/)

### 1.1 ar-async

| #   | File Path                                                     | Status     | 1st Check | 2nd Check | 3rd Check | Notes             |
| --- | ------------------------------------------------------------- | ---------- | --------- | --------- | --------- | ----------------- |
| 1   | packages/ar-async/src/**tests**/ciba-flow-integration.test.ts | N/A        | ✅        | -         | -         |                   |
| 2   | packages/ar-async/src/**tests**/ciba-integration.test.ts      | Translated | ✅        | -         | -         | L408: RFC comment |
| 3   | packages/ar-async/src/**tests**/ciba-jwt-validation.test.ts   | N/A        | ✅        | -         | -         |                   |
| 4   | packages/ar-async/src/**tests**/ciba-ping-mode.test.ts        | N/A        | ✅        | -         | -         |                   |
| 5   | packages/ar-async/src/**tests**/concurrent-requests.test.ts   | N/A        | ✅        | -         | -         |                   |
| 6   | packages/ar-async/src/**tests**/device-expiration.test.ts     | N/A        | ✅        | -         | -         |                   |
| 7   | packages/ar-async/src/**tests**/device-flow-security.test.ts  | N/A        | ✅        | -         | -         |                   |
| 8   | packages/ar-async/src/**tests**/device-state-machine.test.ts  | N/A        | ✅        | -         | -         |                   |
| 9   | packages/ar-async/src/ciba-approve.ts                         | N/A        | ✅        | -         | -         |                   |
| 10  | packages/ar-async/src/ciba-authorization.ts                   | N/A        | ✅        | -         | -         |                   |
| 11  | packages/ar-async/src/ciba-deny.ts                            | N/A        | ✅        | -         | -         |                   |
| 12  | packages/ar-async/src/ciba-details.ts                         | N/A        | ✅        | -         | -         |                   |
| 13  | packages/ar-async/src/ciba-pending.ts                         | N/A        | ✅        | -         | -         |                   |
| 14  | packages/ar-async/src/ciba-test-page.ts                       | N/A        | ✅        | -         | -         |                   |
| 15  | packages/ar-async/src/device-authorization.ts                 | N/A        | ✅        | -         | -         |                   |
| 16  | packages/ar-async/src/device-verify-api.ts                    | N/A        | ✅        | -         | -         |                   |
| 17  | packages/ar-async/src/device-verify.ts                        | N/A        | ✅        | -         | -         |                   |
| 18  | packages/ar-async/src/index.ts                                | N/A        | ✅        | -         | -         |                   |

### 1.2 ar-auth

| #   | File Path                                                         | Status       | 1st Check | 2nd Check | 3rd Check | Notes                   |
| --- | ----------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----------------------- |
| 19  | packages/ar-auth/src/**tests**/auth-params.test.ts                | Untranslated | -         | -         | -         |                         |
| 20  | packages/ar-auth/src/**tests**/authorize-hybrid-flow.test.ts      | Untranslated | -         | -         | -         |                         |
| 21  | packages/ar-auth/src/**tests**/authorize.test.ts                  | Untranslated | -         | -         | -         |                         |
| 22  | packages/ar-auth/src/**tests**/consent.test.ts                    | Untranslated | -         | -         | -         |                         |
| 23  | packages/ar-auth/src/**tests**/did-auth.test.ts                   | Untranslated | -         | -         | -         |                         |
| 24  | packages/ar-auth/src/**tests**/did-link.test.ts                   | Untranslated | -         | -         | -         |                         |
| 25  | packages/ar-auth/src/**tests**/email-code.test.ts                 | Untranslated | -         | -         | -         |                         |
| 26  | packages/ar-auth/src/**tests**/https-request-uri-security.test.ts | Untranslated | -         | -         | -         |                         |
| 27  | packages/ar-auth/src/**tests**/hybrid-flow-security.test.ts       | Untranslated | -         | -         | -         |                         |
| 28  | packages/ar-auth/src/**tests**/jar-advanced.test.ts               | Untranslated | -         | -         | -         |                         |
| 29  | packages/ar-auth/src/**tests**/jarm.test.ts                       | Untranslated | -         | -         | -         |                         |
| 30  | packages/ar-auth/src/**tests**/logout-integration.test.ts         | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 31  | packages/ar-auth/src/**tests**/logout.test.ts                     | Untranslated | -         | -         | -         |                         |
| 32  | packages/ar-auth/src/**tests**/passkey.test.ts                    | Untranslated | -         | -         | -         |                         |
| 33  | packages/ar-auth/src/**tests**/request-object.test.ts             | Untranslated | -         | -         | -         |                         |
| 34  | packages/ar-auth/src/authorize.ts                                 | Untranslated | -         | -         | -         |                         |
| 35  | packages/ar-auth/src/config.ts                                    | Untranslated | -         | -         | -         |                         |
| 36  | packages/ar-auth/src/consent.ts                                   | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 37  | packages/ar-auth/src/did-auth.ts                                  | Untranslated | -         | -         | -         |                         |
| 38  | packages/ar-auth/src/did-link.ts                                  | Untranslated | -         | -         | -         |                         |
| 39  | packages/ar-auth/src/email-code.ts                                | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 40  | packages/ar-auth/src/index.ts                                     | Untranslated | -         | -         | -         |                         |
| 41  | packages/ar-auth/src/login-challenge.ts                           | Untranslated | -         | -         | -         |                         |
| 42  | packages/ar-auth/src/logout.ts                                    | Untranslated | -         | -         | -         |                         |
| 43  | packages/ar-auth/src/par.ts                                       | Untranslated | -         | -         | -         |                         |
| 44  | packages/ar-auth/src/passkey.ts                                   | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 45  | packages/ar-auth/src/session-management.ts                        | Untranslated | -         | -         | -         |                         |
| 46  | packages/ar-auth/src/utils/**tests**/email-code-utils.test.ts     | Untranslated | -         | -         | -         |                         |
| 47  | packages/ar-auth/src/utils/email-code-utils.ts                    | Untranslated | -         | -         | -         |                         |
| 48  | packages/ar-auth/src/utils/email/templates.ts                     | Untranslated | -         | -         | -         |                         |
| 49  | packages/ar-auth/src/warmup.ts                                    | Untranslated | -         | -         | -         |                         |

### 1.3 ar-bridge

| #   | File Path                                                             | Status       | 1st Check | 2nd Check | 3rd Check | Notes                   |
| --- | --------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----------------------- |
| 50  | packages/ar-bridge/src/**tests**/admin-providers.test.ts              | Untranslated | -         | -         | -         |                         |
| 51  | packages/ar-bridge/src/**tests**/callback.test.ts                     | Untranslated | -         | -         | -         |                         |
| 52  | packages/ar-bridge/src/**tests**/crypto.test.ts                       | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 53  | packages/ar-bridge/src/**tests**/github.test.ts                       | Untranslated | -         | -         | -         |                         |
| 54  | packages/ar-bridge/src/**tests**/identity-stitching.test.ts           | Untranslated | -         | -         | -         |                         |
| 55  | packages/ar-bridge/src/**tests**/jit-provisioning.integration.test.ts | Untranslated | -         | -         | -         |                         |
| 56  | packages/ar-bridge/src/**tests**/microsoft.test.ts                    | Untranslated | -         | -         | -         |                         |
| 57  | packages/ar-bridge/src/**tests**/oidc-client.test.ts                  | Untranslated | -         | -         | -         |                         |
| 58  | packages/ar-bridge/src/**tests**/pkce.test.ts                         | Untranslated | -         | -         | -         |                         |
| 59  | packages/ar-bridge/src/**tests**/start.test.ts                        | Untranslated | -         | -         | -         |                         |
| 60  | packages/ar-bridge/src/**tests**/state.test.ts                        | Untranslated | -         | -         | -         |                         |
| 61  | packages/ar-bridge/src/admin/providers.ts                             | Untranslated | -         | -         | -         |                         |
| 62  | packages/ar-bridge/src/clients/oidc-client.ts                         | Untranslated | -         | -         | -         |                         |
| 63  | packages/ar-bridge/src/handlers/backchannel-logout.ts                 | Untranslated | -         | -         | -         |                         |
| 64  | packages/ar-bridge/src/handlers/callback.ts                           | Untranslated | -         | -         | -         |                         |
| 65  | packages/ar-bridge/src/handlers/link.ts                               | Untranslated | -         | -         | -         |                         |
| 66  | packages/ar-bridge/src/handlers/list.ts                               | Untranslated | -         | -         | -         |                         |
| 67  | packages/ar-bridge/src/handlers/start.ts                              | Untranslated | -         | -         | -         |                         |
| 68  | packages/ar-bridge/src/index.ts                                       | Untranslated | -         | -         | -         |                         |
| 69  | packages/ar-bridge/src/providers/apple.ts                             | Untranslated | -         | -         | -         |                         |
| 70  | packages/ar-bridge/src/providers/facebook.ts                          | Untranslated | -         | -         | -         |                         |
| 71  | packages/ar-bridge/src/providers/github.ts                            | Untranslated | -         | -         | -         |                         |
| 72  | packages/ar-bridge/src/providers/google.ts                            | Untranslated | -         | -         | -         |                         |
| 73  | packages/ar-bridge/src/providers/index.ts                             | Untranslated | -         | -         | -         |                         |
| 74  | packages/ar-bridge/src/providers/linkedin.ts                          | Untranslated | -         | -         | -         |                         |
| 75  | packages/ar-bridge/src/providers/microsoft.ts                         | Untranslated | -         | -         | -         |                         |
| 76  | packages/ar-bridge/src/providers/twitter.ts                           | Untranslated | -         | -         | -         |                         |
| 77  | packages/ar-bridge/src/services/identity-stitching.ts                 | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 78  | packages/ar-bridge/src/services/linked-identity-store.ts              | Untranslated | -         | -         | -         |                         |
| 79  | packages/ar-bridge/src/services/provider-store.ts                     | Untranslated | -         | -         | -         |                         |
| 80  | packages/ar-bridge/src/services/token-refresh.ts                      | Untranslated | -         | -         | -         |                         |
| 81  | packages/ar-bridge/src/services/token-revocation.ts                   | Untranslated | -         | -         | -         |                         |
| 82  | packages/ar-bridge/src/types/index.ts                                 | Untranslated | -         | -         | -         |                         |
| 83  | packages/ar-bridge/src/utils/apple-jwt.ts                             | Untranslated | -         | -         | -         |                         |
| 84  | packages/ar-bridge/src/utils/crypto.ts                                | Untranslated | -         | -         | -         |                         |
| 85  | packages/ar-bridge/src/utils/pkce.ts                                  | Untranslated | -         | -         | -         |                         |
| 86  | packages/ar-bridge/src/utils/state.ts                                 | Untranslated | -         | -         | -         |                         |

### 1.4 ar-discovery

| #   | File Path                                             | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | ----------------------------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 87  | packages/ar-discovery/src/**tests**/discovery.test.ts | Untranslated | -         | -         | -         |       |
| 88  | packages/ar-discovery/src/**tests**/jwks.test.ts      | Untranslated | -         | -         | -         |       |
| 89  | packages/ar-discovery/src/discovery.ts                | Untranslated | -         | -         | -         |       |
| 90  | packages/ar-discovery/src/index.ts                    | Untranslated | -         | -         | -         |       |
| 91  | packages/ar-discovery/src/jwks.ts                     | Untranslated | -         | -         | -         |       |

### 1.5 ar-lib-core

| #   | File Path                                                                         | Status       | 1st Check | 2nd Check | 3rd Check | Notes                   |
| --- | --------------------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----------------------- |
| 92  | packages/ar-lib-core/src/**tests**/settings-manager.test.ts                       | Untranslated | -         | -         | -         |                         |
| 93  | packages/ar-lib-core/src/actor/actor-context.ts                                   | Untranslated | -         | -         | -         |                         |
| 94  | packages/ar-lib-core/src/actor/actor-storage.ts                                   | Untranslated | -         | -         | -         |                         |
| 95  | packages/ar-lib-core/src/actor/adapters/cloudflare-actor-adapter.ts               | Untranslated | -         | -         | -         |                         |
| 96  | packages/ar-lib-core/src/actor/index.ts                                           | Untranslated | -         | -         | -         |                         |
| 97  | packages/ar-lib-core/src/constants.ts                                             | Untranslated | -         | -         | -         |                         |
| 98  | packages/ar-lib-core/src/context/factory.ts                                       | Untranslated | -         | -         | -         |                         |
| 99  | packages/ar-lib-core/src/context/hono-context.ts                                  | Untranslated | -         | -         | -         |                         |
| 100 | packages/ar-lib-core/src/context/index.ts                                         | Untranslated | -         | -         | -         |                         |
| 101 | packages/ar-lib-core/src/context/types.ts                                         | Untranslated | -         | -         | -         |                         |
| 102 | packages/ar-lib-core/src/db/**tests**/escape-like-pattern.test.ts                 | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 103 | packages/ar-lib-core/src/db/**tests**/partition-router.test.ts                    | Untranslated | -         | -         | -         |                         |
| 104 | packages/ar-lib-core/src/db/adapter.ts                                            | Untranslated | -         | -         | -         |                         |
| 105 | packages/ar-lib-core/src/db/adapters/d1-adapter.ts                                | Untranslated | -         | -         | -         |                         |
| 106 | packages/ar-lib-core/src/db/adapters/index.ts                                     | Untranslated | -         | -         | -         |                         |
| 107 | packages/ar-lib-core/src/db/index.ts                                              | Untranslated | -         | -         | -         |                         |
| 108 | packages/ar-lib-core/src/db/partition-router.ts                                   | Untranslated | -         | -         | -         |                         |
| 109 | packages/ar-lib-core/src/durable-objects/**tests**/AuthorizationCodeStore.test.ts | Untranslated | -         | -         | -         |                         |
| 110 | packages/ar-lib-core/src/durable-objects/**tests**/DPoPJTIStore.test.ts           | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 111 | packages/ar-lib-core/src/durable-objects/**tests**/KeyManager.test.ts             | Untranslated | -         | -         | -         |                         |
| 112 | packages/ar-lib-core/src/durable-objects/**tests**/PARRequestStore.test.ts        | Untranslated | -         | -         | -         |                         |
| 113 | packages/ar-lib-core/src/durable-objects/**tests**/RefreshTokenRotator.test.ts    | Untranslated | -         | -         | -         |                         |
| 114 | packages/ar-lib-core/src/durable-objects/**tests**/SessionStore.test.ts           | Untranslated | -         | -         | -         |                         |
| 115 | packages/ar-lib-core/src/durable-objects/**tests**/TokenRevocationStore.test.ts   | Untranslated | -         | -         | -         |                         |
| 116 | packages/ar-lib-core/src/durable-objects/**tests**/VersionManager.test.ts         | Untranslated | -         | -         | -         |                         |
| 117 | packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts                | Untranslated | -         | -         | -         |                         |
| 118 | packages/ar-lib-core/src/durable-objects/ChallengeStore.ts                        | Untranslated | -         | -         | -         |                         |
| 119 | packages/ar-lib-core/src/durable-objects/CIBARequestStore.ts                      | Untranslated | -         | -         | -         |                         |
| 120 | packages/ar-lib-core/src/durable-objects/DeviceCodeStore.ts                       | Untranslated | -         | -         | -         |                         |
| 121 | packages/ar-lib-core/src/durable-objects/DPoPJTIStore.ts                          | Untranslated | -         | -         | -         |                         |
| 122 | packages/ar-lib-core/src/durable-objects/index.ts                                 | Untranslated | -         | -         | -         |                         |
| 123 | packages/ar-lib-core/src/durable-objects/KeyManager.ts                            | Untranslated | -         | -         | -         |                         |
| 124 | packages/ar-lib-core/src/durable-objects/PARRequestStore.ts                       | Untranslated | -         | -         | -         |                         |
| 125 | packages/ar-lib-core/src/durable-objects/PermissionChangeHub.ts                   | Untranslated | -         | -         | -         |                         |
| 126 | packages/ar-lib-core/src/durable-objects/RateLimiterCounter.ts                    | Untranslated | -         | -         | -         |                         |
| 127 | packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts                   | Untranslated | -         | -         | -         |                         |
| 128 | packages/ar-lib-core/src/durable-objects/SAMLRequestStore.test.ts                 | Untranslated | -         | -         | -         |                         |
| 129 | packages/ar-lib-core/src/durable-objects/SAMLRequestStore.ts                      | Untranslated | -         | -         | -         |                         |
| 130 | packages/ar-lib-core/src/durable-objects/SessionStore.ts                          | Untranslated | -         | -         | -         |                         |
| 131 | packages/ar-lib-core/src/durable-objects/TokenRevocationStore.ts                  | Untranslated | -         | -         | -         |                         |
| 132 | packages/ar-lib-core/src/durable-objects/UserCodeRateLimiter.ts                   | Untranslated | -         | -         | -         |                         |
| 133 | packages/ar-lib-core/src/durable-objects/VersionManager.ts                        | Untranslated | -         | -         | -         |                         |
| 134 | packages/ar-lib-core/src/errors/**tests**/factory.test.ts                         | N/A          | ✅        | -         | -         | Test data (i18n)        |
| 135 | packages/ar-lib-core/src/errors/**tests**/security.test.ts                        | N/A          | ✅        | -         | -         | Test data (i18n)        |
| 136 | packages/ar-lib-core/src/errors/**tests**/serializer.test.ts                      | Untranslated | -         | -         | -         |                         |
| 137 | packages/ar-lib-core/src/errors/codes.ts                                          | Untranslated | -         | -         | -         |                         |
| 138 | packages/ar-lib-core/src/errors/factory.ts                                        | Untranslated | -         | -         | -         |                         |
| 139 | packages/ar-lib-core/src/errors/index.ts                                          | Untranslated | -         | -         | -         |                         |
| 140 | packages/ar-lib-core/src/errors/middleware.ts                                     | Untranslated | -         | -         | -         |                         |
| 141 | packages/ar-lib-core/src/errors/resolver.ts                                       | Untranslated | -         | -         | -         |                         |
| 142 | packages/ar-lib-core/src/errors/security.ts                                       | Untranslated | -         | -         | -         |                         |
| 143 | packages/ar-lib-core/src/errors/serializer.ts                                     | Untranslated | -         | -         | -         |                         |
| 144 | packages/ar-lib-core/src/errors/types.ts                                          | Untranslated | -         | -         | -         |                         |
| 145 | packages/ar-lib-core/src/index.ts                                                 | Untranslated | -         | -         | -         |                         |
| 146 | packages/ar-lib-core/src/middleware/**tests**/admin-auth.test.ts                  | Untranslated | -         | -         | -         |                         |
| 147 | packages/ar-lib-core/src/middleware/**tests**/rate-limit.test.ts                  | Untranslated | -         | -         | -         |                         |
| 148 | packages/ar-lib-core/src/middleware/**tests**/version-check.test.ts               | Untranslated | -         | -         | -         |                         |
| 149 | packages/ar-lib-core/src/middleware/admin-auth.ts                                 | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 150 | packages/ar-lib-core/src/middleware/initial-access-token.ts                       | Untranslated | -         | -         | -         |                         |
| 151 | packages/ar-lib-core/src/middleware/plugin-context.ts                             | Untranslated | -         | -         | -         |                         |
| 152 | packages/ar-lib-core/src/middleware/rate-limit.ts                                 | Untranslated | -         | -         | -         |                         |
| 153 | packages/ar-lib-core/src/middleware/rbac.ts                                       | Untranslated | -         | -         | -         |                         |
| 154 | packages/ar-lib-core/src/middleware/request-context.ts                            | Untranslated | -         | -         | -         |                         |
| 155 | packages/ar-lib-core/src/middleware/scim-auth.ts                                  | Untranslated | -         | -         | -         |                         |
| 156 | packages/ar-lib-core/src/middleware/version-check.ts                              | Untranslated | -         | -         | -         |                         |
| 157 | packages/ar-lib-core/src/migrations/runner.ts                                     | Untranslated | -         | -         | -         |                         |
| 158 | packages/ar-lib-core/src/notifications/**tests**/ciba-notifications.test.ts       | Untranslated | -         | -         | -         |                         |
| 159 | packages/ar-lib-core/src/notifications/ciba-ping.ts                               | Untranslated | -         | -         | -         |                         |
| 160 | packages/ar-lib-core/src/notifications/ciba-push.ts                               | Untranslated | -         | -         | -         |                         |
| 161 | packages/ar-lib-core/src/notifications/index.ts                                   | Untranslated | -         | -         | -         |                         |
| 162 | packages/ar-lib-core/src/rebac/cache-manager.ts                                   | Untranslated | -         | -         | -         |                         |
| 163 | packages/ar-lib-core/src/rebac/closure-manager.ts                                 | Untranslated | -         | -         | -         |                         |
| 164 | packages/ar-lib-core/src/rebac/index.ts                                           | Untranslated | -         | -         | -         |                         |
| 165 | packages/ar-lib-core/src/rebac/interfaces.ts                                      | Untranslated | -         | -         | -         |                         |
| 166 | packages/ar-lib-core/src/rebac/rebac-service.ts                                   | Untranslated | -         | -         | -         |                         |
| 167 | packages/ar-lib-core/src/rebac/relation-parser.ts                                 | Untranslated | -         | -         | -         |                         |
| 168 | packages/ar-lib-core/src/rebac/types.ts                                           | Untranslated | -         | -         | -         |                         |
| 169 | packages/ar-lib-core/src/repositories/**tests**/cache.test.ts                     | Untranslated | -         | -         | -         |                         |
| 170 | packages/ar-lib-core/src/repositories/**tests**/mock-adapter.ts                   | Untranslated | -         | -         | -         |                         |
| 171 | packages/ar-lib-core/src/repositories/**tests**/user-core.test.ts                 | Untranslated | -         | -         | -         |                         |
| 172 | packages/ar-lib-core/src/repositories/**tests**/user-pii.test.ts                  | Untranslated | -         | -         | -         |                         |
| 173 | packages/ar-lib-core/src/repositories/base.ts                                     | Untranslated | -         | -         | -         |                         |
| 174 | packages/ar-lib-core/src/repositories/cache/index.ts                              | Untranslated | -         | -         | -         |                         |
| 175 | packages/ar-lib-core/src/repositories/core/client.ts                              | Untranslated | -         | -         | -         |                         |
| 176 | packages/ar-lib-core/src/repositories/core/index.ts                               | Untranslated | -         | -         | -         |                         |
| 177 | packages/ar-lib-core/src/repositories/core/passkey.ts                             | Untranslated | -         | -         | -         |                         |
| 178 | packages/ar-lib-core/src/repositories/core/role.ts                                | Untranslated | -         | -         | -         |                         |
| 179 | packages/ar-lib-core/src/repositories/core/session-client.ts                      | Untranslated | -         | -         | -         |                         |
| 180 | packages/ar-lib-core/src/repositories/core/session.ts                             | Untranslated | -         | -         | -         |                         |
| 181 | packages/ar-lib-core/src/repositories/core/user-core.ts                           | Untranslated | -         | -         | -         |                         |
| 182 | packages/ar-lib-core/src/repositories/index.ts                                    | Untranslated | -         | -         | -         |                         |
| 183 | packages/ar-lib-core/src/repositories/pii/audit-log.ts                            | Untranslated | -         | -         | -         |                         |
| 184 | packages/ar-lib-core/src/repositories/pii/index.ts                                | Untranslated | -         | -         | -         |                         |
| 185 | packages/ar-lib-core/src/repositories/pii/linked-identity.ts                      | Untranslated | -         | -         | -         |                         |
| 186 | packages/ar-lib-core/src/repositories/pii/subject-identifier.ts                   | Untranslated | -         | -         | -         |                         |
| 187 | packages/ar-lib-core/src/repositories/pii/tombstone.ts                            | Untranslated | -         | -         | -         |                         |
| 188 | packages/ar-lib-core/src/repositories/pii/user-pii.ts                             | Untranslated | -         | -         | -         |                         |
| 189 | packages/ar-lib-core/src/repositories/vc/attribute-verification.ts                | Untranslated | -         | -         | -         |                         |
| 190 | packages/ar-lib-core/src/repositories/vc/did-document-cache.ts                    | Untranslated | -         | -         | -         |                         |
| 191 | packages/ar-lib-core/src/repositories/vc/index.ts                                 | Untranslated | -         | -         | -         |                         |
| 192 | packages/ar-lib-core/src/repositories/vc/issued-credential.ts                     | Untranslated | -         | -         | -         |                         |
| 193 | packages/ar-lib-core/src/repositories/vc/status-list.ts                           | Untranslated | -         | -         | -         |                         |
| 194 | packages/ar-lib-core/src/repositories/vc/trusted-issuer.ts                        | Untranslated | -         | -         | -         |                         |
| 195 | packages/ar-lib-core/src/repositories/vc/user-verified-attribute.ts               | Untranslated | -         | -         | -         |                         |
| 196 | packages/ar-lib-core/src/services/**tests**/backchannel-logout-sender.test.ts     | Untranslated | -         | -         | -         |                         |
| 197 | packages/ar-lib-core/src/services/**tests**/frontchannel-logout.test.ts           | Untranslated | -         | -         | -         |                         |
| 198 | packages/ar-lib-core/src/services/**tests**/rule-evaluator.test.ts                | Untranslated | -         | -         | -         |                         |
| 199 | packages/ar-lib-core/src/services/**tests**/token-claim-evaluator.test.ts         | Untranslated | -         | -         | -         |                         |
| 200 | packages/ar-lib-core/src/services/**tests**/unified-check-service.test.ts         | Untranslated | -         | -         | -         |                         |
| 201 | packages/ar-lib-core/src/services/backchannel-logout-sender.ts                    | Untranslated | -         | -         | -         |                         |
| 202 | packages/ar-lib-core/src/services/frontchannel-logout.ts                          | Untranslated | -         | -         | -         |                         |
| 203 | packages/ar-lib-core/src/services/org-domain-resolver.ts                          | Untranslated | -         | -         | -         |                         |
| 204 | packages/ar-lib-core/src/services/permission-change-notifier.ts                   | Untranslated | -         | -         | -         |                         |
| 205 | packages/ar-lib-core/src/services/rule-evaluator.ts                               | Untranslated | -         | -         | -         |                         |
| 206 | packages/ar-lib-core/src/services/token-claim-evaluator.ts                        | Untranslated | -         | -         | -         |                         |
| 207 | packages/ar-lib-core/src/services/unified-check-service.ts                        | Untranslated | -         | -         | -         |                         |
| 208 | packages/ar-lib-core/src/storage/adapters/**tests**/cloudflare-adapter.test.ts    | Untranslated | -         | -         | -         |                         |
| 209 | packages/ar-lib-core/src/storage/adapters/cloudflare-adapter.ts                   | Untranslated | -         | -         | -         |                         |
| 210 | packages/ar-lib-core/src/storage/interfaces.ts                                    | Untranslated | -         | -         | -         |                         |
| 211 | packages/ar-lib-core/src/storage/repositories/index.ts                            | Untranslated | -         | -         | -         |                         |
| 212 | packages/ar-lib-core/src/storage/repositories/organization-store.ts               | Untranslated | -         | -         | -         |                         |
| 213 | packages/ar-lib-core/src/storage/repositories/relationship-store.ts               | Untranslated | -         | -         | -         |                         |
| 214 | packages/ar-lib-core/src/storage/repositories/role-assignment-store.ts            | Untranslated | -         | -         | -         |                         |
| 215 | packages/ar-lib-core/src/storage/repositories/role-store.ts                       | Untranslated | -         | -         | -         |                         |
| 216 | packages/ar-lib-core/src/test/fixtures.ts                                         | Untranslated | -         | -         | -         |                         |
| 217 | packages/ar-lib-core/src/test/setup.ts                                            | Untranslated | -         | -         | -         |                         |
| 218 | packages/ar-lib-core/src/types/**tests**/did.test.ts                              | Untranslated | -         | -         | -         |                         |
| 219 | packages/ar-lib-core/src/types/admin.ts                                           | Untranslated | -         | -         | -         |                         |
| 220 | packages/ar-lib-core/src/types/check-api.ts                                       | Untranslated | -         | -         | -         |                         |
| 221 | packages/ar-lib-core/src/types/consent.ts                                         | Untranslated | -         | -         | -         |                         |
| 222 | packages/ar-lib-core/src/types/did.ts                                             | Untranslated | -         | -         | -         |                         |
| 223 | packages/ar-lib-core/src/types/env.ts                                             | Untranslated | -         | -         | -         |                         |
| 224 | packages/ar-lib-core/src/types/jit-config.ts                                      | Untranslated | -         | -         | -         |                         |
| 225 | packages/ar-lib-core/src/types/logout.ts                                          | Untranslated | -         | -         | -         |                         |
| 226 | packages/ar-lib-core/src/types/oidc.ts                                            | Untranslated | -         | -         | -         |                         |
| 227 | packages/ar-lib-core/src/types/openid4vci.ts                                      | Untranslated | -         | -         | -         |                         |
| 228 | packages/ar-lib-core/src/types/openid4vp.ts                                       | Untranslated | -         | -         | -         |                         |
| 229 | packages/ar-lib-core/src/types/policy-rules.ts                                    | Untranslated | -         | -         | -         |                         |
| 230 | packages/ar-lib-core/src/types/rbac.ts                                            | Untranslated | -         | -         | -         |                         |
| 231 | packages/ar-lib-core/src/types/saml.ts                                            | Untranslated | -         | -         | -         |                         |
| 232 | packages/ar-lib-core/src/types/scim.ts                                            | Untranslated | -         | -         | -         |                         |
| 233 | packages/ar-lib-core/src/types/settings/ciba.ts                                   | Untranslated | -         | -         | -         |                         |
| 234 | packages/ar-lib-core/src/types/settings/client.ts                                 | Untranslated | -         | -         | -         |                         |
| 235 | packages/ar-lib-core/src/types/settings/common.ts                                 | Untranslated | -         | -         | -         |                         |
| 236 | packages/ar-lib-core/src/types/settings/consent.ts                                | Untranslated | -         | -         | -         |                         |
| 237 | packages/ar-lib-core/src/types/settings/credentials.ts                            | Untranslated | -         | -         | -         |                         |
| 238 | packages/ar-lib-core/src/types/settings/device-flow.ts                            | Untranslated | -         | -         | -         |                         |
| 239 | packages/ar-lib-core/src/types/settings/encryption.ts                             | Untranslated | -         | -         | -         |                         |
| 240 | packages/ar-lib-core/src/types/settings/external-idp.ts                           | Untranslated | -         | -         | -         |                         |
| 241 | packages/ar-lib-core/src/types/settings/federation.ts                             | Untranslated | -         | -         | -         |                         |
| 242 | packages/ar-lib-core/src/types/settings/index.ts                                  | Untranslated | -         | -         | -         |                         |
| 243 | packages/ar-lib-core/src/types/settings/infrastructure.ts                         | Untranslated | -         | -         | -         |                         |
| 244 | packages/ar-lib-core/src/types/settings/oauth.ts                                  | Untranslated | -         | -         | -         |                         |
| 245 | packages/ar-lib-core/src/types/settings/rate-limit.ts                             | Untranslated | -         | -         | -         |                         |
| 246 | packages/ar-lib-core/src/types/settings/scim.ts                                   | Untranslated | -         | -         | -         |                         |
| 247 | packages/ar-lib-core/src/types/settings/security.ts                               | Untranslated | -         | -         | -         |                         |
| 248 | packages/ar-lib-core/src/types/settings/session.ts                                | Untranslated | -         | -         | -         |                         |
| 249 | packages/ar-lib-core/src/types/settings/tokens.ts                                 | Untranslated | -         | -         | -         |                         |
| 250 | packages/ar-lib-core/src/types/token-claim-rules.ts                               | Untranslated | -         | -         | -         |                         |
| 251 | packages/ar-lib-core/src/utils/**tests**/audit-log.test.ts                        | Untranslated | -         | -         | -         |                         |
| 252 | packages/ar-lib-core/src/utils/**tests**/ciba-sharding.test.ts                    | Untranslated | -         | -         | -         |                         |
| 253 | packages/ar-lib-core/src/utils/**tests**/ciba.test.ts                             | Untranslated | -         | -         | -         |                         |
| 254 | packages/ar-lib-core/src/utils/**tests**/claim-normalizer.test.ts                 | Untranslated | -         | -         | -         |                         |
| 255 | packages/ar-lib-core/src/utils/**tests**/client-authentication.test.ts            | Untranslated | -         | -         | -         |                         |
| 256 | packages/ar-lib-core/src/utils/**tests**/conformance-config.test.ts               | Untranslated | -         | -         | -         |                         |
| 257 | packages/ar-lib-core/src/utils/**tests**/consent-rbac.test.ts                     | Untranslated | -         | -         | -         |                         |
| 258 | packages/ar-lib-core/src/utils/**tests**/custom-redirect.test.ts                  | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 259 | packages/ar-lib-core/src/utils/**tests**/d1-retry.test.ts                         | Untranslated | -         | -         | -         |                         |
| 260 | packages/ar-lib-core/src/utils/**tests**/device-code-sharding.test.ts             | Untranslated | -         | -         | -         |                         |
| 261 | packages/ar-lib-core/src/utils/**tests**/device-flow-rfc-compliance.test.ts       | Untranslated | -         | -         | -         |                         |
| 262 | packages/ar-lib-core/src/utils/**tests**/device-flow.test.ts                      | Untranslated | -         | -         | -         |                         |
| 263 | packages/ar-lib-core/src/utils/**tests**/dpop-jti-sharding.test.ts                | Untranslated | -         | -         | -         |                         |
| 264 | packages/ar-lib-core/src/utils/**tests**/dpop.test.ts                             | Untranslated | -         | -         | -         |                         |
| 265 | packages/ar-lib-core/src/utils/**tests**/ec-keys.test.ts                          | Untranslated | -         | -         | -         |                         |
| 266 | packages/ar-lib-core/src/utils/**tests**/email-domain-hash.test.ts                | Untranslated | -         | -         | -         |                         |
| 267 | packages/ar-lib-core/src/utils/**tests**/error-response.test.ts                   | Untranslated | -         | -         | -         |                         |
| 268 | packages/ar-lib-core/src/utils/**tests**/issuer.test.ts                           | Untranslated | -         | -         | -         |                         |
| 269 | packages/ar-lib-core/src/utils/**tests**/jwe.test.ts                              | Untranslated | -         | -         | -         |                         |
| 270 | packages/ar-lib-core/src/utils/**tests**/jwt-bearer.test.ts                       | Untranslated | -         | -         | -         |                         |
| 271 | packages/ar-lib-core/src/utils/**tests**/jwt-jwe.test.ts                          | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 272 | packages/ar-lib-core/src/utils/**tests**/jwt.test.ts                              | Untranslated | -         | -         | -         |                         |
| 273 | packages/ar-lib-core/src/utils/**tests**/keys.test.ts                             | Untranslated | -         | -         | -         |                         |
| 274 | packages/ar-lib-core/src/utils/**tests**/kv.test.ts                               | Untranslated | -         | -         | -         |                         |
| 275 | packages/ar-lib-core/src/utils/**tests**/logout-validation.test.ts                | Untranslated | -         | -         | -         |                         |
| 276 | packages/ar-lib-core/src/utils/**tests**/pairwise.test.ts                         | Untranslated | -         | -         | -         |                         |
| 277 | packages/ar-lib-core/src/utils/**tests**/par-sharding.test.ts                     | Untranslated | -         | -         | -         |                         |
| 278 | packages/ar-lib-core/src/utils/**tests**/pii-encryption.test.ts                   | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 279 | packages/ar-lib-core/src/utils/**tests**/pkce.test.ts                             | Untranslated | -         | -         | -         |                         |
| 280 | packages/ar-lib-core/src/utils/**tests**/policy-embedding.test.ts                 | Untranslated | -         | -         | -         |                         |
| 281 | packages/ar-lib-core/src/utils/**tests**/region-sharding.test.ts                  | Untranslated | -         | -         | -         |                         |
| 282 | packages/ar-lib-core/src/utils/**tests**/resource-permissions.test.ts             | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 283 | packages/ar-lib-core/src/utils/**tests**/scim-filter.test.ts                      | Untranslated | -         | -         | -         |                         |
| 284 | packages/ar-lib-core/src/utils/**tests**/scim-mapper.test.ts                      | Untranslated | -         | -         | -         |                         |
| 285 | packages/ar-lib-core/src/utils/**tests**/sd-jwt.test.ts                           | Untranslated | -         | -         | -         |                         |
| 286 | packages/ar-lib-core/src/utils/**tests**/session-state.test.ts                    | Untranslated | -         | -         | -         |                         |
| 287 | packages/ar-lib-core/src/utils/**tests**/tenant-context.test.ts                   | Untranslated | -         | -         | -         |                         |
| 288 | packages/ar-lib-core/src/utils/**tests**/token-introspection.test.ts              | Untranslated | -         | -         | -         |                         |
| 289 | packages/ar-lib-core/src/utils/**tests**/ui-config.test.ts                        | Untranslated | -         | -         | -         |                         |
| 290 | packages/ar-lib-core/src/utils/**tests**/ui-url-validator.test.ts                 | Untranslated | -         | -         | -         |                         |
| 291 | packages/ar-lib-core/src/utils/**tests**/validation-security.test.ts              | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 292 | packages/ar-lib-core/src/utils/**tests**/validation.test.ts                       | Untranslated | -         | -         | -         |                         |
| 293 | packages/ar-lib-core/src/utils/**tests**/verify-token.test.ts                     | Untranslated | -         | -         | -         |                         |
| 294 | packages/ar-lib-core/src/utils/audit-log.ts                                       | Untranslated | -         | -         | -         |                         |
| 295 | packages/ar-lib-core/src/utils/authcode-helper.ts                                 | Untranslated | -         | -         | -         |                         |
| 296 | packages/ar-lib-core/src/utils/challenge-sharding.ts                              | Untranslated | -         | -         | -         |                         |
| 297 | packages/ar-lib-core/src/utils/ciba-sharding.ts                                   | Untranslated | -         | -         | -         |                         |
| 298 | packages/ar-lib-core/src/utils/ciba.ts                                            | Untranslated | -         | -         | -         |                         |
| 299 | packages/ar-lib-core/src/utils/claim-normalizer.ts                                | Untranslated | -         | -         | -         |                         |
| 300 | packages/ar-lib-core/src/utils/client-authentication.ts                           | Untranslated | -         | -         | -         |                         |
| 301 | packages/ar-lib-core/src/utils/conformance-config.ts                              | Untranslated | -         | -         | -         |                         |
| 302 | packages/ar-lib-core/src/utils/consent-rbac.ts                                    | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 303 | packages/ar-lib-core/src/utils/crypto.ts                                          | Untranslated | -         | -         | -         |                         |
| 304 | packages/ar-lib-core/src/utils/custom-redirect.ts                                 | Untranslated | -         | -         | -         |                         |
| 305 | packages/ar-lib-core/src/utils/d1-retry.ts                                        | Untranslated | -         | -         | -         |                         |
| 306 | packages/ar-lib-core/src/utils/device-code-sharding.ts                            | Untranslated | -         | -         | -         |                         |
| 307 | packages/ar-lib-core/src/utils/device-flow.ts                                     | Untranslated | -         | -         | -         |                         |
| 308 | packages/ar-lib-core/src/utils/do-retry.ts                                        | Untranslated | -         | -         | -         |                         |
| 309 | packages/ar-lib-core/src/utils/dpop-jti-sharding.ts                               | Untranslated | -         | -         | -         |                         |
| 310 | packages/ar-lib-core/src/utils/dpop.ts                                            | Untranslated | -         | -         | -         |                         |
| 311 | packages/ar-lib-core/src/utils/ec-keys.ts                                         | Untranslated | -         | -         | -         |                         |
| 312 | packages/ar-lib-core/src/utils/email-domain-hash.ts                               | Untranslated | -         | -         | -         |                         |
| 313 | packages/ar-lib-core/src/utils/encryption-config.ts                               | Untranslated | -         | -         | -         |                         |
| 314 | packages/ar-lib-core/src/utils/errors.ts                                          | Untranslated | -         | -         | -         |                         |
| 315 | packages/ar-lib-core/src/utils/feature-flags.ts                                   | Translated   | ✅        | -         | -         | CLAUDE.md reference     |
| 316 | packages/ar-lib-core/src/utils/id.ts                                              | Untranslated | -         | -         | -         |                         |
| 317 | packages/ar-lib-core/src/utils/issuer.ts                                          | Untranslated | -         | -         | -         |                         |
| 318 | packages/ar-lib-core/src/utils/jwe.ts                                             | Untranslated | -         | -         | -         |                         |
| 319 | packages/ar-lib-core/src/utils/jwt-bearer.ts                                      | Untranslated | -         | -         | -         |                         |
| 320 | packages/ar-lib-core/src/utils/jwt.ts                                             | Untranslated | -         | -         | -         |                         |
| 321 | packages/ar-lib-core/src/utils/keys.ts                                            | Untranslated | -         | -         | -         |                         |
| 322 | packages/ar-lib-core/src/utils/kv.ts                                              | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 323 | packages/ar-lib-core/src/utils/logger.ts                                          | Untranslated | -         | -         | -         |                         |
| 324 | packages/ar-lib-core/src/utils/logout-validation.ts                               | Untranslated | -         | -         | -         |                         |
| 325 | packages/ar-lib-core/src/utils/oauth-config.ts                                    | Untranslated | -         | -         | -         |                         |
| 326 | packages/ar-lib-core/src/utils/origin-validator.ts                                | Untranslated | -         | -         | -         |                         |
| 327 | packages/ar-lib-core/src/utils/pairwise.ts                                        | Untranslated | -         | -         | -         |                         |
| 328 | packages/ar-lib-core/src/utils/par-sharding.ts                                    | Untranslated | -         | -         | -         |                         |
| 329 | packages/ar-lib-core/src/utils/pii-encryption.ts                                  | Untranslated | -         | -         | -         |                         |
| 330 | packages/ar-lib-core/src/utils/policy-embedding.ts                                | Untranslated | -         | -         | -         |                         |
| 331 | packages/ar-lib-core/src/utils/rbac-claims.ts                                     | Translated   | ✅        | -         | -         | KV/env/default comments |
| 332 | packages/ar-lib-core/src/utils/refresh-token-sharding.ts                          | Untranslated | -         | -         | -         |                         |
| 333 | packages/ar-lib-core/src/utils/region-sharding.ts                                 | Untranslated | -         | -         | -         |                         |
| 334 | packages/ar-lib-core/src/utils/resource-permissions.ts                            | Untranslated | -         | -         | -         |                         |
| 335 | packages/ar-lib-core/src/utils/scim-filter.ts                                     | Untranslated | -         | -         | -         |                         |
| 336 | packages/ar-lib-core/src/utils/scim-mapper.ts                                     | Untranslated | -         | -         | -         |                         |
| 337 | packages/ar-lib-core/src/utils/sd-jwt.ts                                          | Untranslated | -         | -         | -         |                         |
| 338 | packages/ar-lib-core/src/utils/session-helper.ts                                  | Untranslated | -         | -         | -         |                         |
| 339 | packages/ar-lib-core/src/utils/session-state.ts                                   | Untranslated | -         | -         | -         |                         |
| 340 | packages/ar-lib-core/src/utils/settings-manager.ts                                | Translated   | ✅        | -         | -         | API design comments     |
| 341 | packages/ar-lib-core/src/utils/tenant-context.ts                                  | Translated   | ✅        | -         | -         | KV/env/default comments |
| 342 | packages/ar-lib-core/src/utils/token-introspection.ts                             | Untranslated | -         | -         | -         |                         |
| 343 | packages/ar-lib-core/src/utils/token-revocation-sharding.ts                       | Untranslated | -         | -         | -         |                         |
| 344 | packages/ar-lib-core/src/utils/ui-config.ts                                       | Untranslated | -         | -         | -         |                         |
| 345 | packages/ar-lib-core/src/utils/ui-url-validator.ts                                | Untranslated | -         | -         | -         |                         |
| 346 | packages/ar-lib-core/src/utils/url-security.ts                                    | Untranslated | -         | -         | -         |                         |
| 347 | packages/ar-lib-core/src/utils/validation.ts                                      | Untranslated | -         | -         | -         |                         |
| 348 | packages/ar-lib-core/src/vc/**tests**/haip-policy.test.ts                         | Untranslated | -         | -         | -         |                         |
| 349 | packages/ar-lib-core/src/vc/**tests**/sd-jwt-vc.test.ts                           | Untranslated | -         | -         | -         |                         |
| 350 | packages/ar-lib-core/src/vc/**tests**/status-list-manager.test.ts                 | Untranslated | -         | -         | -         |                         |
| 351 | packages/ar-lib-core/src/vc/**tests**/status-list.test.ts                         | Untranslated | -         | -         | -         |                         |
| 352 | packages/ar-lib-core/src/vc/haip-policy.ts                                        | Untranslated | -         | -         | -         |                         |
| 353 | packages/ar-lib-core/src/vc/sd-jwt-vc.ts                                          | Untranslated | -         | -         | -         |                         |
| 354 | packages/ar-lib-core/src/vc/status-list-manager.ts                                | Untranslated | -         | -         | -         |                         |
| 355 | packages/ar-lib-core/src/vc/status-list.ts                                        | Untranslated | -         | -         | -         |                         |

### 1.6 ar-lib-plugin

| #   | File Path                                                 | Status       | 1st Check | 2nd Check | 3rd Check | Notes               |
| --- | --------------------------------------------------------- | ------------ | --------- | --------- | --------- | ------------------- |
| 356 | packages/ar-lib-plugin/src/**tests**/plugin.test.ts       | Untranslated | -         | -         | -         |                     |
| 357 | packages/ar-lib-plugin/src/builtin/authenticator/index.ts | Untranslated | -         | -         | -         |                     |
| 358 | packages/ar-lib-plugin/src/builtin/authenticator/totp.ts  | Translated   | ✅        | -         | -         | Plugin descriptions |
| 359 | packages/ar-lib-plugin/src/builtin/index.ts               | Untranslated | -         | -         | -         |                     |
| 360 | packages/ar-lib-plugin/src/builtin/notifier/console.ts    | Translated   | ✅        | -         | -         | Plugin descriptions |
| 361 | packages/ar-lib-plugin/src/builtin/notifier/index.ts      | Untranslated | -         | -         | -         |                     |
| 362 | packages/ar-lib-plugin/src/builtin/notifier/resend.ts     | Translated   | ✅        | -         | -         | Plugin descriptions |
| 363 | packages/ar-lib-plugin/src/builtin/notifier/types.ts      | Untranslated | -         | -         | -         |                     |
| 364 | packages/ar-lib-plugin/src/core/context.ts                | Untranslated | -         | -         | -         |                     |
| 365 | packages/ar-lib-plugin/src/core/index.ts                  | Untranslated | -         | -         | -         |                     |
| 366 | packages/ar-lib-plugin/src/core/loader.ts                 | Translated   | ✅        | -         | -         | Init order comment  |
| 367 | packages/ar-lib-plugin/src/core/registry.ts               | Untranslated | -         | -         | -         |                     |
| 368 | packages/ar-lib-plugin/src/core/schema.ts                 | Untranslated | -         | -         | -         |                     |
| 369 | packages/ar-lib-plugin/src/core/security.ts               | Untranslated | -         | -         | -         |                     |
| 370 | packages/ar-lib-plugin/src/core/types.ts                  | Untranslated | -         | -         | -         |                     |
| 371 | packages/ar-lib-plugin/src/index.ts                       | Translated   | ✅        | -         | -         | Export comments     |
| 372 | packages/ar-lib-plugin/src/infra/index.ts                 | Untranslated | -         | -         | -         |                     |
| 373 | packages/ar-lib-plugin/src/infra/policy/builtin/index.ts  | Untranslated | -         | -         | -         |                     |
| 374 | packages/ar-lib-plugin/src/infra/policy/factory.ts        | Untranslated | -         | -         | -         |                     |
| 375 | packages/ar-lib-plugin/src/infra/policy/index.ts          | Untranslated | -         | -         | -         |                     |
| 376 | packages/ar-lib-plugin/src/infra/types.ts                 | Untranslated | -         | -         | -         |                     |

### 1.7 ar-lib-policy

| #   | File Path                                                    | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | ------------------------------------------------------------ | ------------ | --------- | --------- | --------- | ----- |
| 377 | packages/ar-lib-policy/src/**tests**/abac-conditions.test.ts | Untranslated | -         | -         | -         |       |
| 378 | packages/ar-lib-policy/src/**tests**/engine.test.ts          | Untranslated | -         | -         | -         |       |
| 379 | packages/ar-lib-policy/src/**tests**/feature-flags.test.ts   | Untranslated | -         | -         | -         |       |
| 380 | packages/ar-lib-policy/src/**tests**/role-checker.test.ts    | Untranslated | -         | -         | -         |       |
| 381 | packages/ar-lib-policy/src/engine.ts                         | Untranslated | -         | -         | -         |       |
| 382 | packages/ar-lib-policy/src/feature-flags.ts                  | Untranslated | -         | -         | -         |       |
| 383 | packages/ar-lib-policy/src/index.ts                          | Untranslated | -         | -         | -         |       |
| 384 | packages/ar-lib-policy/src/role-checker.ts                   | Untranslated | -         | -         | -         |       |
| 385 | packages/ar-lib-policy/src/types.ts                          | Untranslated | -         | -         | -         |       |

### 1.8 ar-lib-scim

| #   | File Path                                              | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | ------------------------------------------------------ | ------------ | --------- | --------- | --------- | ----- |
| 386 | packages/ar-lib-scim/src/**tests**/scim-filter.test.ts | Untranslated | -         | -         | -         |       |
| 387 | packages/ar-lib-scim/src/**tests**/scim-mapper.test.ts | Untranslated | -         | -         | -         |       |
| 388 | packages/ar-lib-scim/src/index.ts                      | Untranslated | -         | -         | -         |       |
| 389 | packages/ar-lib-scim/src/middleware/scim-auth.ts       | Untranslated | -         | -         | -         |       |
| 390 | packages/ar-lib-scim/src/types/scim.ts                 | Untranslated | -         | -         | -         |       |
| 391 | packages/ar-lib-scim/src/utils/scim-filter.ts          | Untranslated | -         | -         | -         |       |
| 392 | packages/ar-lib-scim/src/utils/scim-mapper.ts          | Untranslated | -         | -         | -         |       |

### 1.9 ar-management

| #   | File Path                                                              | Status       | 1st Check | 2nd Check | 3rd Check | Notes                   |
| --- | ---------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----------------------- |
| 393 | packages/ar-management/src/**tests**/admin.test.ts                     | Untranslated | -         | -         | -         |                         |
| 394 | packages/ar-management/src/**tests**/introspect.test.ts                | Untranslated | -         | -         | -         |                         |
| 395 | packages/ar-management/src/**tests**/introspection-cache.test.ts       | Untranslated | -         | -         | -         |                         |
| 396 | packages/ar-management/src/**tests**/logout-config.test.ts             | Untranslated | -         | -         | -         |                         |
| 397 | packages/ar-management/src/**tests**/register.test.ts                  | Untranslated | -         | -         | -         |                         |
| 398 | packages/ar-management/src/**tests**/revoke.test.ts                    | Untranslated | -         | -         | -         |                         |
| 399 | packages/ar-management/src/**tests**/scim-tokens.test.ts               | N/A          | ✅        | -         | -         | Test data (encoding)    |
| 400 | packages/ar-management/src/**tests**/scim.test.ts                      | Untranslated | -         | -         | -         |                         |
| 401 | packages/ar-management/src/**tests**/settings-migrate.test.ts          | Untranslated | -         | -         | -         |                         |
| 402 | packages/ar-management/src/**tests**/settings-v2.test.ts               | Untranslated | -         | -         | -         |                         |
| 403 | packages/ar-management/src/**tests**/signing-keys.test.ts              | Untranslated | -         | -         | -         |                         |
| 404 | packages/ar-management/src/admin-rbac.ts                               | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 405 | packages/ar-management/src/admin.ts                                    | Untranslated | -         | -         | -         |                         |
| 406 | packages/ar-management/src/certification-profiles.ts                   | Untranslated | -         | -         | -         |                         |
| 407 | packages/ar-management/src/iat-tokens.ts                               | Untranslated | -         | -         | -         |                         |
| 408 | packages/ar-management/src/index.ts                                    | Untranslated | -         | -         | -         |                         |
| 409 | packages/ar-management/src/introspect.ts                               | Untranslated | -         | -         | -         |                         |
| 410 | packages/ar-management/src/register.ts                                 | Untranslated | -         | -         | -         |                         |
| 411 | packages/ar-management/src/revoke.ts                                   | Untranslated | -         | -         | -         |                         |
| 412 | packages/ar-management/src/routes/settings-v2/index.ts                 | Untranslated | -         | -         | -         |                         |
| 413 | packages/ar-management/src/routes/settings-v2/migrate.ts               | Translated   | ✅        | -         | -         | Spec comment            |
| 414 | packages/ar-management/src/routes/settings/check-api-keys.ts           | Untranslated | -         | -         | -         |                         |
| 415 | packages/ar-management/src/routes/settings/code-shards.ts              | Translated   | ✅        | -         | -         | JSDoc comments          |
| 416 | packages/ar-management/src/routes/settings/conformance-config.ts       | Untranslated | -         | -         | -         |                         |
| 417 | packages/ar-management/src/routes/settings/domain-hash-keys.ts         | Untranslated | -         | -         | -         |                         |
| 418 | packages/ar-management/src/routes/settings/encryption-config.ts        | Untranslated | -         | -         | -         |                         |
| 419 | packages/ar-management/src/routes/settings/error-config.ts             | Untranslated | -         | -         | -         |                         |
| 420 | packages/ar-management/src/routes/settings/fapi-security.ts            | Untranslated | -         | -         | -         |                         |
| 421 | packages/ar-management/src/routes/settings/introspection-cache.ts      | Translated   | ✅        | -         | -         | Security comments       |
| 422 | packages/ar-management/src/routes/settings/introspection-validation.ts | Translated   | ✅        | -         | -         | JSDoc/default comments  |
| 423 | packages/ar-management/src/routes/settings/ip-security.ts              | Untranslated | -         | -         | -         |                         |
| 424 | packages/ar-management/src/routes/settings/jit-provisioning.ts         | Untranslated | -         | -         | -         |                         |
| 425 | packages/ar-management/src/routes/settings/logout-config.ts            | Untranslated | -         | -         | -         |                         |
| 426 | packages/ar-management/src/routes/settings/logout-failures.ts          | Untranslated | -         | -         | -         |                         |
| 427 | packages/ar-management/src/routes/settings/oauth-config.ts             | Untranslated | -         | -         | -         |                         |
| 428 | packages/ar-management/src/routes/settings/org-domain-mappings.ts      | Untranslated | -         | -         | -         |                         |
| 429 | packages/ar-management/src/routes/settings/pii-partitions.ts           | Untranslated | -         | -         | -         |                         |
| 430 | packages/ar-management/src/routes/settings/plugins.ts                  | Untranslated | -         | -         | -         |                         |
| 431 | packages/ar-management/src/routes/settings/policy-flags.ts             | Translated   | ✅        | -         | -         | CLAUDE.md reference     |
| 432 | packages/ar-management/src/routes/settings/rate-limit.ts               | Untranslated | -         | -         | -         |                         |
| 433 | packages/ar-management/src/routes/settings/refresh-token-sharding.ts   | Untranslated | -         | -         | -         |                         |
| 434 | packages/ar-management/src/routes/settings/region-shards.ts            | Untranslated | -         | -         | -         |                         |
| 435 | packages/ar-management/src/routes/settings/resource-permissions.ts     | Untranslated | -         | -         | -         |                         |
| 436 | packages/ar-management/src/routes/settings/revocation-shards.ts        | Translated   | ✅        | -         | -         | JSDoc/inline comments   |
| 437 | packages/ar-management/src/routes/settings/role-assignment-rules.ts    | Untranslated | -         | -         | -         |                         |
| 438 | packages/ar-management/src/routes/settings/token-claim-rules.ts        | Untranslated | -         | -         | -         |                         |
| 439 | packages/ar-management/src/routes/settings/token-embedding.ts          | Untranslated | -         | -         | -         |                         |
| 440 | packages/ar-management/src/routes/settings/token-exchange.ts           | Untranslated | -         | -         | -         |                         |
| 441 | packages/ar-management/src/routes/settings/tombstones.ts               | Untranslated | -         | -         | -         |                         |
| 442 | packages/ar-management/src/routes/settings/ui-config.ts                | Untranslated | -         | -         | -         |                         |
| 443 | packages/ar-management/src/routes/vc/credential-status.ts              | Untranslated | -         | -         | -         |                         |
| 444 | packages/ar-management/src/scim-tokens.ts                              | Untranslated | -         | -         | -         |                         |
| 445 | packages/ar-management/src/scim.ts                                     | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 446 | packages/ar-management/src/signing-keys.ts                             | Untranslated | -         | -         | -         |                         |

### 1.10 ar-policy

| #   | File Path                                                          | Status       | 1st Check | 2nd Check | 3rd Check | Notes                  |
| --- | ------------------------------------------------------------------ | ------------ | --------- | --------- | --------- | ---------------------- |
| 447 | packages/ar-policy/src/**tests**/batch-check.test.ts               | Untranslated | -         | -         | -         |                        |
| 448 | packages/ar-policy/src/**tests**/index.test.ts                     | Translated   | ✅        | -         | -         | RFC comments           |
| 449 | packages/ar-policy/src/**tests**/rebac-depth.test.ts               | Untranslated | -         | -         | -         |                        |
| 450 | packages/ar-policy/src/**tests**/tenant-isolation.test.ts          | Untranslated | -         | -         | -         |                        |
| 451 | packages/ar-policy/src/index.ts                                    | Untranslated | -         | -         | -         |                        |
| 452 | packages/ar-policy/src/middleware/**tests**/check-auth.test.ts     | Untranslated | -         | -         | -         |                        |
| 453 | packages/ar-policy/src/middleware/**tests**/rate-limit.test.ts     | Untranslated | -         | -         | -         |                        |
| 454 | packages/ar-policy/src/middleware/check-auth.ts                    | Untranslated | -         | -         | -         |                        |
| 455 | packages/ar-policy/src/middleware/rate-limit.ts                    | Untranslated | -         | -         | -         |                        |
| 456 | packages/ar-policy/src/routes/**tests**/check-feature-flag.test.ts | Translated   | ✅        | -         | -         | CLAUDE.md/RFC comments |
| 457 | packages/ar-policy/src/routes/check.ts                             | Untranslated | -         | -         | -         |                        |
| 458 | packages/ar-policy/src/routes/subscribe.ts                         | Untranslated | -         | -         | -         |                        |

### 1.11 ar-router

| #   | File Path                                       | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | ----------------------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 459 | packages/ar-router/src/**tests**/router.test.ts | Untranslated | -         | -         | -         |       |
| 460 | packages/ar-router/src/index.ts                 | Untranslated | -         | -         | -         |       |

### 1.12 ar-saml

| #   | File Path                                                        | Status       | 1st Check | 2nd Check | 3rd Check | Notes                   |
| --- | ---------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----------------------- |
| 461 | packages/ar-saml/src/**tests**/saml-integration.test.ts          | Untranslated | -         | -         | -         |                         |
| 462 | packages/ar-saml/src/admin/providers.ts                          | Untranslated | -         | -         | -         |                         |
| 463 | packages/ar-saml/src/common/**tests**/redirect-binding.test.ts   | Untranslated | -         | -         | -         |                         |
| 464 | packages/ar-saml/src/common/**tests**/signature-security.test.ts | Untranslated | -         | -         | -         |                         |
| 465 | packages/ar-saml/src/common/**tests**/slo-security.test.ts       | Untranslated | -         | -         | -         |                         |
| 466 | packages/ar-saml/src/common/**tests**/xxe-protection.test.ts     | Untranslated | -         | -         | -         |                         |
| 467 | packages/ar-saml/src/common/constants.ts                         | Untranslated | -         | -         | -         |                         |
| 468 | packages/ar-saml/src/common/key-utils.ts                         | Untranslated | -         | -         | -         |                         |
| 469 | packages/ar-saml/src/common/signature.ts                         | Untranslated | -         | -         | -         |                         |
| 470 | packages/ar-saml/src/common/xml-utils.test.ts                    | Untranslated | -         | -         | -         |                         |
| 471 | packages/ar-saml/src/common/xml-utils.ts                         | Untranslated | -         | -         | -         |                         |
| 472 | packages/ar-saml/src/idp/assertion.test.ts                       | Untranslated | -         | -         | -         |                         |
| 473 | packages/ar-saml/src/idp/assertion.ts                            | Untranslated | -         | -         | -         |                         |
| 474 | packages/ar-saml/src/idp/idp-initiated.ts                        | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 475 | packages/ar-saml/src/idp/metadata.ts                             | Untranslated | -         | -         | -         |                         |
| 476 | packages/ar-saml/src/idp/slo.ts                                  | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 477 | packages/ar-saml/src/idp/sso.ts                                  | Translated   | ✅        | -         | -         | PII/Non-PII DB comment  |
| 478 | packages/ar-saml/src/index.ts                                    | Untranslated | -         | -         | -         |                         |
| 479 | packages/ar-saml/src/sp/**tests**/conditions.test.ts             | Untranslated | -         | -         | -         |                         |
| 480 | packages/ar-saml/src/sp/**tests**/subject-confirmation.test.ts   | Untranslated | -         | -         | -         |                         |
| 481 | packages/ar-saml/src/sp/acs.ts                                   | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |
| 482 | packages/ar-saml/src/sp/login.ts                                 | Untranslated | -         | -         | -         |                         |
| 483 | packages/ar-saml/src/sp/metadata.ts                              | Untranslated | -         | -         | -         |                         |
| 484 | packages/ar-saml/src/sp/slo.ts                                   | Translated   | ✅        | -         | -         | PII/Non-PII DB comments |

### 1.13 ar-token

| #   | File Path                                                       | Status       | 1st Check | 2nd Check | 3rd Check | Notes               |
| --- | --------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ------------------- |
| 485 | packages/ar-token/src/**tests**/client-credentials.test.ts      | Untranslated | -         | -         | -         |                     |
| 486 | packages/ar-token/src/**tests**/device-flow-integration.test.ts | Untranslated | -         | -         | -         |                     |
| 487 | packages/ar-token/src/**tests**/jwe-integration.test.ts         | Untranslated | -         | -         | -         |                     |
| 488 | packages/ar-token/src/**tests**/token-exchange.test.ts          | Untranslated | -         | -         | -         |                     |
| 489 | packages/ar-token/src/index.ts                                  | Untranslated | -         | -         | -         |                     |
| 490 | packages/ar-token/src/token.ts                                  | Translated   | ✅        | -         | -         | KV priority comment |
| 491 | packages/ar-token/src/warmup.ts                                 | Untranslated | -         | -         | -         |                     |

### 1.14 ar-ui

| #    | File Path                                             | Status       | 1st Check | 2nd Check | 3rd Check | Notes                    |
| ---- | ----------------------------------------------------- | ------------ | --------- | --------- | --------- | ------------------------ |
| 492  | packages/ar-ui/src/app.d.ts                           | Untranslated | -         | -         | -         |                          |
| 493  | packages/ar-ui/src/lib/api/client.ts                  | Untranslated | -         | -         | -         |                          |
| 494  | packages/ar-ui/src/lib/components/index.ts            | Untranslated | -         | -         | -         |                          |
| 495  | packages/ar-ui/src/lib/components/Spinner.test.ts     | Untranslated | -         | -         | -         |                          |
| 496  | packages/ar-ui/src/lib/index.ts                       | Untranslated | -         | -         | -         |                          |
| 497  | packages/ar-ui/src/lib/stores/auth.ts                 | Untranslated | -         | -         | -         |                          |
| 498  | packages/ar-ui/src/routes/+layout.server.ts           | Untranslated | -         | -         | -         |                          |
| 499  | packages/ar-ui/src/routes/api/set-language/+server.ts | Untranslated | -         | -         | -         |                          |
| 500  | packages/ar-ui/src/test/setup.ts                      | Untranslated | -         | -         | -         |                          |
| 500a | packages/ar-ui/src/routes/admin/clients/+page.svelte  | Translated   | ✅        | -         | -         | Delete dialog            |
| 500b | packages/ar-ui/src/routes/admin/settings/+page.svelte | N/A          | ✅        | -         | -         | Language selector (i18n) |

### 1.15 ar-userinfo

| #   | File Path                                                       | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | --------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 501 | packages/ar-userinfo/src/**tests**/userinfo-integration.test.ts | Untranslated | -         | -         | -         |       |
| 502 | packages/ar-userinfo/src/**tests**/userinfo.test.ts             | Untranslated | -         | -         | -         |       |
| 503 | packages/ar-userinfo/src/index.ts                               | Untranslated | -         | -         | -         |       |
| 504 | packages/ar-userinfo/src/userinfo.ts                            | Untranslated | -         | -         | -         |       |

### 1.16 ar-vc

| #   | File Path                                                                        | Status       | 1st Check | 2nd Check | 3rd Check | Notes                |
| --- | -------------------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | -------------------- |
| 505 | packages/ar-vc/src/**tests**/integration.test.ts                                 | Untranslated | -         | -         | -         |                      |
| 506 | packages/ar-vc/src/**tests**/wallet-compatibility/haip-compliance.test.ts        | Untranslated | -         | -         | -         |                      |
| 507 | packages/ar-vc/src/**tests**/wallet-simulator/mock-wallet.ts                     | Untranslated | -         | -         | -         |                      |
| 508 | packages/ar-vc/src/did/routes/**tests**/did-routes.test.ts                       | Untranslated | -         | -         | -         |                      |
| 509 | packages/ar-vc/src/did/routes/document.ts                                        | Untranslated | -         | -         | -         |                      |
| 510 | packages/ar-vc/src/did/routes/resolve.ts                                         | Untranslated | -         | -         | -         |                      |
| 511 | packages/ar-vc/src/index.ts                                                      | Untranslated | -         | -         | -         |                      |
| 512 | packages/ar-vc/src/issuer/durable-objects/**tests**/CredentialOfferStore.test.ts | Untranslated | -         | -         | -         |                      |
| 513 | packages/ar-vc/src/issuer/durable-objects/CredentialOfferStore.ts                | Untranslated | -         | -         | -         |                      |
| 514 | packages/ar-vc/src/issuer/routes/**tests**/issuer-routes.test.ts                 | Untranslated | -         | -         | -         |                      |
| 515 | packages/ar-vc/src/issuer/routes/**tests**/status-list.test.ts                   | Untranslated | -         | -         | -         |                      |
| 516 | packages/ar-vc/src/issuer/routes/credential.ts                                   | Untranslated | -         | -         | -         |                      |
| 517 | packages/ar-vc/src/issuer/routes/deferred.ts                                     | Untranslated | -         | -         | -         |                      |
| 518 | packages/ar-vc/src/issuer/routes/metadata.ts                                     | Untranslated | -         | -         | -         |                      |
| 519 | packages/ar-vc/src/issuer/routes/offer.ts                                        | Untranslated | -         | -         | -         |                      |
| 520 | packages/ar-vc/src/issuer/routes/status-list.ts                                  | Untranslated | -         | -         | -         |                      |
| 521 | packages/ar-vc/src/issuer/routes/token.ts                                        | Untranslated | -         | -         | -         |                      |
| 522 | packages/ar-vc/src/issuer/services/token-validation.ts                           | Untranslated | -         | -         | -         |                      |
| 523 | packages/ar-vc/src/types.ts                                                      | Untranslated | -         | -         | -         |                      |
| 524 | packages/ar-vc/src/utils/**tests**/crypto.test.ts                                | N/A          | ✅        | -         | -         | Test data (encoding) |
| 525 | packages/ar-vc/src/utils/credential-offer-sharding.ts                            | Untranslated | -         | -         | -         |                      |
| 526 | packages/ar-vc/src/utils/crypto.ts                                               | Untranslated | -         | -         | -         |                      |
| 527 | packages/ar-vc/src/utils/vc-config.ts                                            | Untranslated | -         | -         | -         |                      |
| 528 | packages/ar-vc/src/utils/vp-request-sharding.ts                                  | Untranslated | -         | -         | -         |                      |
| 529 | packages/ar-vc/src/verifier/durable-objects/**tests**/VPRequestStore.test.ts     | Untranslated | -         | -         | -         |                      |
| 530 | packages/ar-vc/src/verifier/durable-objects/VPRequestStore.ts                    | Untranslated | -         | -         | -         |                      |
| 531 | packages/ar-vc/src/verifier/routes/**tests**/verifier-routes.test.ts             | Untranslated | -         | -         | -         |                      |
| 532 | packages/ar-vc/src/verifier/routes/attribute-verify.ts                           | Untranslated | -         | -         | -         |                      |
| 533 | packages/ar-vc/src/verifier/routes/authorize.ts                                  | Untranslated | -         | -         | -         |                      |
| 534 | packages/ar-vc/src/verifier/routes/metadata.ts                                   | Untranslated | -         | -         | -         |                      |
| 535 | packages/ar-vc/src/verifier/routes/request-status.ts                             | Untranslated | -         | -         | -         |                      |
| 536 | packages/ar-vc/src/verifier/routes/response.ts                                   | Untranslated | -         | -         | -         |                      |
| 537 | packages/ar-vc/src/verifier/services/**tests**/attribute-mapper.test.ts          | Untranslated | -         | -         | -         |                      |
| 538 | packages/ar-vc/src/verifier/services/**tests**/issuer-trust.test.ts              | Untranslated | -         | -         | -         |                      |
| 539 | packages/ar-vc/src/verifier/services/**tests**/vp-verifier.test.ts               | Untranslated | -         | -         | -         |                      |
| 540 | packages/ar-vc/src/verifier/services/attribute-mapper.ts                         | Untranslated | -         | -         | -         |                      |
| 541 | packages/ar-vc/src/verifier/services/issuer-trust.ts                             | Untranslated | -         | -         | -         |                      |
| 542 | packages/ar-vc/src/verifier/services/vp-verifier.ts                              | Untranslated | -         | -         | -         |                      |

---

## 2. Documentation (docs/)

| #   | File Path                                                   | Status       | 1st Check | 2nd Check | 3rd Check | Notes                                             |
| --- | ----------------------------------------------------------- | ------------ | --------- | --------- | --------- | ------------------------------------------------- |
| 543 | docs/architecture/authentication-flows.md                   | Untranslated | -         | -         | -         |                                                   |
| 544 | docs/architecture/breaking-changes.md                       | Translated   | ✅        | -         | -         | Full document                                     |
| 545 | docs/architecture/configuration.md                          | Untranslated | -         | -         | -         |                                                   |
| 546 | docs/architecture/consistency-design.md                     | Translated   | ✅        | -         | -         | Full translation - 99 JP → 0 (garbled text fixed) |
| 547 | docs/architecture/database-schema.md                        | Untranslated | -         | -         | -         |                                                   |
| 548 | docs/architecture/database-storage-analysis.md              | Untranslated | -         | -         | -         |                                                   |
| 549 | docs/architecture/durable-objects-sharding.md               | Untranslated | -         | -         | -         |                                                   |
| 550 | docs/architecture/durable-objects.md                        | Untranslated | -         | -         | -         |                                                   |
| 551 | docs/architecture/durable-objects/AuthorizationCodeStore.md | Untranslated | -         | -         | -         |                                                   |
| 552 | docs/architecture/durable-objects/KeyManager.md             | Untranslated | -         | -         | -         |                                                   |
| 553 | docs/architecture/durable-objects/RefreshTokenRotator.md    | Untranslated | -         | -         | -         |                                                   |
| 554 | docs/architecture/durable-objects/SessionStore.md           | Untranslated | -         | -         | -         |                                                   |
| 555 | docs/architecture/error-handling.md                         | Untranslated | -         | -         | -         |                                                   |
| 556 | docs/architecture/events.md                                 | Translated   | ✅        | -         | -         | Full document                                     |
| 557 | docs/architecture/future-plans.md                           | Untranslated | -         | -         | -         |                                                   |
| 558 | docs/architecture/hyper-scale-analysis.md                   | Untranslated | -         | -         | -         |                                                   |
| 559 | docs/architecture/key-management.md                         | Untranslated | -         | -         | -         |                                                   |
| 560 | docs/architecture/multi-tenancy.md                          | Untranslated | -         | -         | -         |                                                   |
| 561 | docs/architecture/overview.md                               | N/A          | -         | -         | -         | Already in English                                |
| 562 | docs/architecture/patterns.md                               | Untranslated | -         | -         | -         |                                                   |
| 563 | docs/architecture/phase8-unified-policy-integration.md      | Untranslated | -         | -         | -         |                                                   |
| 564 | docs/architecture/pii-migration-guide.md                    | Translated   | ✅        | -         | -         | Full document                                     |
| 565 | docs/architecture/pii-separation-architecture.md            | Translated   | -         | -         | -         | Full translation - 458 JP → 0                     |
| 566 | docs/architecture/protocol-flow.md                          | Untranslated | -         | -         | -         |                                                   |
| 567 | docs/architecture/rebac.md                                  | Untranslated | -         | -         | -         |                                                   |
| 568 | docs/architecture/refresh-token-sharding.md                 | Translated   | ✅        | -         | -         | Section 3.1 + changelog                           |
| 569 | docs/architecture/router-setup.md                           | Untranslated | -         | -         | -         |                                                   |
| 570 | docs/architecture/scim-implementation.md                    | Untranslated | -         | -         | -         |                                                   |
| 571 | docs/architecture/security.md                               | Untranslated | -         | -         | -         |                                                   |
| 572 | docs/architecture/storage-strategy.md                       | Untranslated | -         | -         | -         |                                                   |
| 573 | docs/architecture/token-sharding.md                         | Untranslated | -         | -         | -         |                                                   |
| 574 | docs/architecture/user-cache.md                             | Untranslated | -         | -         | -         |                                                   |
| 575 | docs/architecture/workers.md                                | Untranslated | -         | -         | -         |                                                   |
| 576 | docs/design/accessibility.md                                | Untranslated | -         | -         | -         |                                                   |
| 577 | docs/design/design-system.md                                | Untranslated | -         | -         | -         |                                                   |
| 578 | docs/design/wireframes.md                                   | Untranslated | -         | -         | -         |                                                   |
| 579 | docs/designs/a6-logout-design.md                            | Translated   | ✅        | -         | -         | Full document (887 lines)                         |
| 580 | docs/errors/error-codes-reference.md                        | Untranslated | -         | -         | -         |                                                   |
| 581 | docs/errors/error-specification.md                          | Untranslated | -         | -         | -         |                                                   |
| 582 | docs/features/ciba.md                                       | Untranslated | -         | -         | -         |                                                   |
| 583 | docs/features/client-authentication.md                      | Untranslated | -         | -         | -         |                                                   |
| 584 | docs/features/custom-redirect-uris.md                       | Untranslated | -         | -         | -         |                                                   |
| 585 | docs/features/device-flow.md                                | Untranslated | -         | -         | -         |                                                   |
| 586 | docs/features/discovery.md                                  | Untranslated | -         | -         | -         |                                                   |
| 587 | docs/features/dpop.md                                       | Untranslated | -         | -         | -         |                                                   |
| 588 | docs/features/dynamic-client-registration.md                | Untranslated | -         | -         | -         |                                                   |
| 589 | docs/features/external-idp.md                               | Untranslated | -         | -         | -         |                                                   |
| 590 | docs/features/form-post-response-mode.md                    | Untranslated | -         | -         | -         |                                                   |
| 591 | docs/features/hybrid-flow.md                                | Untranslated | -         | -         | -         |                                                   |
| 592 | docs/features/jar-jarm.md                                   | Untranslated | -         | -         | -         |                                                   |
| 593 | docs/features/logout.md                                     | Untranslated | -         | -         | -         |                                                   |
| 594 | docs/features/oidc-core.md                                  | Untranslated | -         | -         | -         |                                                   |
| 595 | docs/features/pairwise-subject-identifiers.md               | Untranslated | -         | -         | -         |                                                   |
| 596 | docs/features/par.md                                        | Untranslated | -         | -         | -         |                                                   |
| 597 | docs/features/passkey-webauthn.md                           | Untranslated | -         | -         | -         |                                                   |
| 598 | docs/features/pkce.md                                       | Untranslated | -         | -         | -         |                                                   |
| 599 | docs/features/saml.md                                       | Untranslated | -         | -         | -         |                                                   |
| 600 | docs/features/scim.md                                       | Untranslated | -         | -         | -         |                                                   |
| 601 | docs/features/session-management.md                         | Untranslated | -         | -         | -         |                                                   |
| 602 | docs/features/token-exchange.md                             | Untranslated | -         | -         | -         |                                                   |
| 603 | docs/features/token-management.md                           | Untranslated | -         | -         | -         |                                                   |
| 604 | docs/features/userinfo.md                                   | Untranslated | -         | -         | -         |                                                   |
| 605 | docs/getting-started/deployment.md                          | Untranslated | -         | -         | -         |                                                   |
| 606 | docs/getting-started/development.md                         | Untranslated | -         | -         | -         |                                                   |
| 607 | docs/getting-started/testing.md                             | Untranslated | -         | -         | -         |                                                   |
| 608 | docs/guides/admin/performance.md                            | Untranslated | -         | -         | -         |                                                   |
| 609 | docs/guides/admin/secret-management.md                      | Untranslated | -         | -         | -         |                                                   |
| 610 | docs/guides/integration/compatibility.md                    | Untranslated | -         | -         | -         |                                                   |
| 611 | docs/guides/integration/quick-reference.md                  | Untranslated | -         | -         | -         |                                                   |
| 612 | docs/guides/social-login/apple.md                           | Untranslated | -         | -         | -         |                                                   |
| 613 | docs/guides/social-login/facebook.md                        | Untranslated | -         | -         | -         |                                                   |
| 614 | docs/guides/social-login/github.md                          | Untranslated | -         | -         | -         |                                                   |
| 615 | docs/guides/social-login/google.md                          | Untranslated | -         | -         | -         |                                                   |
| 616 | docs/guides/social-login/linkedin.md                        | Untranslated | -         | -         | -         |                                                   |
| 617 | docs/guides/social-login/microsoft.md                       | Untranslated | -         | -         | -         |                                                   |
| 618 | docs/guides/social-login/README.md                          | Untranslated | -         | -         | -         |                                                   |
| 619 | docs/guides/social-login/twitter.md                         | Untranslated | -         | -         | -         |                                                   |
| 620 | docs/operations/performance-optimization.md                 | Untranslated | -         | -         | -         |                                                   |
| 621 | docs/operations/version-management.md                       | Untranslated | -         | -         | -         |                                                   |
| 622 | docs/operations/worker-optimization.md                      | Untranslated | -         | -         | -         |                                                   |
| 623 | docs/PLUGIN_DEVELOPER_GUIDE.md                              | Untranslated | -         | -         | -         |                                                   |
| 624 | docs/PLUGIN_DISTRIBUTION_POLICY.md                          | Translated   | ✅        | -         | -         | Full document                                     |
| 625 | docs/PLUGIN_SYSTEM_SPECIFICATION.md                         | Untranslated | -         | -         | -         |                                                   |
| 626 | docs/README.md                                              | Untranslated | -         | -         | -         |                                                   |
| 627 | docs/reference/api/admin/avatars.md                         | Untranslated | -         | -         | -         |                                                   |
| 628 | docs/reference/api/admin/clients.md                         | Untranslated | -         | -         | -         |                                                   |
| 629 | docs/reference/api/admin/sessions.md                        | Untranslated | -         | -         | -         |                                                   |
| 630 | docs/reference/api/admin/settings.md                        | Translated   | ✅        | -         | -         |                                                   |
| 631 | docs/reference/api/admin/statistics.md                      | Untranslated | -         | -         | -         |                                                   |
| 632 | docs/reference/api/admin/users.md                           | Untranslated | -         | -         | -         |                                                   |
| 633 | docs/reference/api/auth/consent.md                          | Untranslated | -         | -         | -         |                                                   |
| 634 | docs/reference/api/auth/logout.md                           | Untranslated | -         | -         | -         |                                                   |
| 635 | docs/reference/api/auth/magic-link.md                       | Untranslated | -         | -         | -         |                                                   |
| 636 | docs/reference/api/auth/passkey.md                          | Untranslated | -         | -         | -         |                                                   |
| 637 | docs/reference/api/auth/session-management.md               | Untranslated | -         | -         | -         |                                                   |
| 638 | docs/reference/api/list.md                                  | Untranslated | -         | -         | -         |                                                   |
| 639 | docs/reference/api/naming-conventions.md                    | Untranslated | -         | -         | -         |                                                   |
| 640 | docs/reference/api/policy/CHECK_API.md                      | Untranslated | -         | -         | -         |                                                   |
| 641 | docs/reference/api/policy/CONFIGURATION.md                  | Untranslated | -         | -         | -         |                                                   |
| 642 | docs/reference/api/policy/README.md                         | Untranslated | -         | -         | -         |                                                   |
| 643 | docs/reference/api/policy/TOKEN_EMBEDDING.md                | Untranslated | -         | -         | -         |                                                   |
| 644 | docs/reference/api/README.md                                | Untranslated | -         | -         | -         |                                                   |
| 645 | docs/reference/api/vc/README.md                             | Untranslated | -         | -         | -         |                                                   |
| 646 | docs/reference/storage.md                                   | Untranslated | -         | -         | -         |                                                   |
| 647 | docs/ROADMAP.md                                             | Translated   | ✅        | -         | -         | Partial (Japanese sections)                       |
| 648 | docs/sdk/error-handling-guide.md                            | N/A          | ✅        | -         | -         | English + i18n demo example                       |
| 649 | docs/security/envelope-encryption.md                        | Untranslated | -         | -         | -         |                                                   |
| 650 | docs/VISION.md                                              | Untranslated | -         | -         | -         |                                                   |

---

## 3. Scripts (scripts/)

| #   | File Path                                | Status       | 1st Check | 2nd Check | 3rd Check | Notes          |
| --- | ---------------------------------------- | ------------ | --------- | --------- | --------- | -------------- |
| 651 | scripts/apply-migrations.sh              | Untranslated | -         | -         | -         |                |
| 652 | scripts/build.sh                         | Untranslated | -         | -         | -         |                |
| 653 | scripts/check-d1-sizes.ts                | Translated   | ✅        | -         | -         | Console output |
| 654 | scripts/check-d1-table-sizes.sh          | Translated   | ✅        | -         | -         | Console output |
| 655 | scripts/create-migration.ts              | Untranslated | -         | -         | -         |                |
| 656 | scripts/delete-all.sh                    | Untranslated | -         | -         | -         |                |
| 657 | scripts/delete-d1.sh                     | Untranslated | -         | -         | -         |                |
| 658 | scripts/delete-kv.sh                     | Untranslated | -         | -         | -         |                |
| 659 | scripts/delete-workers.sh                | Untranslated | -         | -         | -         |                |
| 660 | scripts/deploy-all.sh                    | Untranslated | -         | -         | -         |                |
| 661 | scripts/deploy-remote-ui.sh              | Untranslated | -         | -         | -         |                |
| 662 | scripts/deploy-ui.sh                     | Untranslated | -         | -         | -         |                |
| 663 | scripts/deploy-with-retry.sh             | Untranslated | -         | -         | -         |                |
| 664 | scripts/generate-initial-access-token.sh | Untranslated | -         | -         | -         |                |
| 665 | scripts/generate-tenant-migration.ts     | Untranslated | -         | -         | -         |                |
| 666 | scripts/performance-test.sh              | Untranslated | -         | -         | -         |                |
| 667 | scripts/setup-config.sh                  | Untranslated | -         | -         | -         |                |
| 668 | scripts/setup-d1.sh                      | Untranslated | -         | -         | -         |                |
| 669 | scripts/setup-default-settings.sh        | Untranslated | -         | -         | -         |                |
| 670 | scripts/setup-durable-objects.sh         | Untranslated | -         | -         | -         |                |
| 671 | scripts/setup-github.sh                  | Untranslated | -         | -         | -         |                |
| 672 | scripts/setup-keys.sh                    | Untranslated | -         | -         | -         |                |
| 673 | scripts/setup-kv.sh                      | Untranslated | -         | -         | -         |                |
| 674 | scripts/setup-local-vars.sh              | Untranslated | -         | -         | -         |                |
| 675 | scripts/setup-local-wrangler.sh          | Untranslated | -         | -         | -         |                |
| 676 | scripts/setup-remote-cors.sh             | Untranslated | -         | -         | -         |                |
| 677 | scripts/setup-remote-wrangler.sh         | Untranslated | -         | -         | -         |                |
| 678 | scripts/setup-resend.sh                  | Untranslated | -         | -         | -         |                |
| 679 | scripts/setup-secrets.sh                 | Untranslated | -         | -         | -         |                |
| 680 | scripts/switch-certification-profile.sh  | Untranslated | -         | -         | -         |                |
| 681 | scripts/watch-deployments.sh             | Translated   | ✅        | -         | -         | Console output |

---

## 4. Conformance Tests (conformance/)

| #   | File Path                                       | Status       | 1st Check | 2nd Check | 3rd Check | Notes                    |
| --- | ----------------------------------------------- | ------------ | --------- | --------- | --------- | ------------------------ |
| 682 | conformance/CONFORMANCE-ISSUES.md               | Translated   | ✅        | -         | -         | Full translation         |
| 683 | conformance/FAPI-2.0-STATUS.md                  | Untranslated | -         | -         | -         |                          |
| 684 | conformance/OPENID-CERTIFICATION.md             | Untranslated | -         | -         | -         |                          |
| 685 | conformance/README.md                           | Untranslated | -         | -         | -         |                          |
| 686 | conformance/scripts/check-image-placeholders.ts | Untranslated | -         | -         | -         |                          |
| 687 | conformance/scripts/CONFORMANCE_TESTING_TIPS.md | Translated   | ✅        | -         | -         | Full translation         |
| 688 | conformance/scripts/docs/test-spec-format.md    | Untranslated | -         | -         | -         |                          |
| 689 | conformance/scripts/generate-test-spec.ts       | Translated   | ✅        | -         | -         | Screenshot timing labels |
| 690 | conformance/scripts/get-test-details.ts         | Untranslated | -         | -         | -         |                          |
| 691 | conformance/scripts/lib/browser-automator.ts    | N/A          | ✅        | -         | -         | Bilingual UI selectors   |
| 692 | conformance/scripts/lib/conformance-client.ts   | Untranslated | -         | -         | -         |                          |
| 693 | conformance/scripts/lib/logger.ts               | Untranslated | -         | -         | -         |                          |
| 694 | conformance/scripts/lib/profile-manager.ts      | Untranslated | -         | -         | -         |                          |
| 695 | conformance/scripts/lib/result-processor.ts     | Untranslated | -         | -         | -         |                          |
| 696 | conformance/scripts/lib/types.ts                | Untranslated | -         | -         | -         |                          |
| 697 | conformance/scripts/README.md                   | Untranslated | -         | -         | -         |                          |
| 698 | conformance/scripts/run-conformance.ts          | Untranslated | -         | -         | -         |                          |
| 699 | conformance/scripts/run-vci-tests.ts            | Untranslated | -         | -         | -         |                          |
| 700 | conformance/scripts/run-vp-tests.ts             | Untranslated | -         | -         | -         |                          |
| 701 | conformance/tools/plan-cleanup/cleanup.ts       | Untranslated | -         | -         | -         |                          |

---

## 5. Load Testing (load-testing/)

| #   | File Path                                                                   | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | --------------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 702 | load-testing/scripts/benchmarks/test-authorize-silent-benchmark-cloud.js    | Untranslated | -         | -         | -         |       |
| 703 | load-testing/scripts/benchmarks/test-authorize-silent-benchmark.js          | Untranslated | -         | -         | -         |       |
| 704 | load-testing/scripts/benchmarks/test-introspect-benchmark-cloud.js          | Untranslated | -         | -         | -         |       |
| 705 | load-testing/scripts/benchmarks/test-introspect-benchmark.js                | Untranslated | -         | -         | -         |       |
| 706 | load-testing/scripts/benchmarks/test-mail-otp-full-login-benchmark-cloud.js | Untranslated | -         | -         | -         |       |
| 707 | load-testing/scripts/benchmarks/test-mail-otp-full-login-benchmark.js       | Untranslated | -         | -         | -         |       |
| 708 | load-testing/scripts/benchmarks/test-passkey-full-login-benchmark-vm.js     | Untranslated | -         | -         | -         |       |
| 709 | load-testing/scripts/benchmarks/test-passkey-full-login-benchmark.js        | Untranslated | -         | -         | -         |       |
| 710 | load-testing/scripts/benchmarks/test-refresh.js                             | Untranslated | -         | -         | -         |       |
| 711 | load-testing/scripts/benchmarks/test-token-exchange-benchmark-cloud.js      | Untranslated | -         | -         | -         |       |
| 712 | load-testing/scripts/benchmarks/test-token-exchange-benchmark.js            | Untranslated | -         | -         | -         |       |
| 713 | load-testing/scripts/benchmarks/test-userinfo-benchmark-cloud.js            | Untranslated | -         | -         | -         |       |
| 714 | load-testing/scripts/benchmarks/test-userinfo-benchmark.js                  | Untranslated | -         | -         | -         |       |
| 715 | load-testing/scripts/seeds/seed-access-tokens.js                            | Untranslated | -         | -         | -         |       |
| 716 | load-testing/scripts/seeds/seed-authcodes.js                                | Untranslated | -         | -         | -         |       |
| 717 | load-testing/scripts/seeds/seed-otp-users.js                                | Untranslated | -         | -         | -         |       |
| 718 | load-testing/scripts/seeds/seed-passkey-users.js                            | Untranslated | -         | -         | -         |       |
| 719 | load-testing/scripts/seeds/seed-refresh-tokens.js                           | Untranslated | -         | -         | -         |       |
| 720 | load-testing/scripts/utils/report-cf-analytics.js                           | Untranslated | -         | -         | -         |       |

---

## 6. E2E Tests (test-e2e/)

| #   | File Path                        | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | -------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 721 | test-e2e/accessibility.spec.ts   | Untranslated | -         | -         | -         |       |
| 722 | test-e2e/auth-flow.spec.ts       | Untranslated | -         | -         | -         |       |
| 723 | test-e2e/homepage.spec.ts        | Untranslated | -         | -         | -         |       |
| 724 | test-e2e/language-switch.spec.ts | Untranslated | -         | -         | -         |       |
| 725 | test-e2e/oidc-flow.spec.ts       | Untranslated | -         | -         | -         |       |

---

## 7. Root Files

| #   | File Path            | Status       | 1st Check | 2nd Check | 3rd Check | Notes                  |
| --- | -------------------- | ------------ | --------- | --------- | --------- | ---------------------- |
| 726 | CLAUDE.md            | Translated   | ✅        | -         | -         | Development guidelines |
| 727 | CONTRIBUTING.md      | Untranslated | -         | -         | -         |                        |
| 728 | eslint.config.js     | Untranslated | -         | -         | -         |                        |
| 729 | playwright.config.ts | Untranslated | -         | -         | -         |                        |
| 730 | README.md            | Translated   | ✅        | -         | -         | 1 JP phrase fixed      |
| 731 | SECURITY.md          | Untranslated | -         | -         | -         |                        |
| 732 | vitest.config.ts     | Untranslated | -         | -         | -         |                        |

---

## 8. Claude Skills (.claude/skills/)

| #   | File Path                                                              | Status       | 1st Check | 2nd Check | 3rd Check | Notes |
| --- | ---------------------------------------------------------------------- | ------------ | --------- | --------- | --------- | ----- |
| 733 | .claude/skills/oidc-compliance/authrim/durable-objects.md              | Untranslated | -         | -         | -         |       |
| 734 | .claude/skills/oidc-compliance/authrim/error-handling.md               | Untranslated | -         | -         | -         |       |
| 735 | .claude/skills/oidc-compliance/authrim/kv-config-pattern.md            | Untranslated | -         | -         | -         |       |
| 736 | .claude/skills/oidc-compliance/authrim/pii-separation.md               | Untranslated | -         | -         | -         |       |
| 737 | .claude/skills/oidc-compliance/checklists/authorize-endpoint.md        | Untranslated | -         | -         | -         |       |
| 738 | .claude/skills/oidc-compliance/checklists/device-endpoint.md           | Untranslated | -         | -         | -         |       |
| 739 | .claude/skills/oidc-compliance/checklists/introspection-endpoint.md    | Untranslated | -         | -         | -         |       |
| 740 | .claude/skills/oidc-compliance/checklists/par-endpoint.md              | Untranslated | -         | -         | -         |       |
| 741 | .claude/skills/oidc-compliance/checklists/revocation-endpoint.md       | Untranslated | -         | -         | -         |       |
| 742 | .claude/skills/oidc-compliance/checklists/token-endpoint.md            | Untranslated | -         | -         | -         |       |
| 743 | .claude/skills/oidc-compliance/checklists/userinfo-endpoint.md         | Untranslated | -         | -         | -         |       |
| 744 | .claude/skills/oidc-compliance/patterns/security-violations.md         | Untranslated | -         | -         | -         |       |
| 745 | .claude/skills/oidc-compliance/patterns/token-handling.md              | Untranslated | -         | -         | -         |       |
| 746 | .claude/skills/oidc-compliance/patterns/validation-gaps.md             | Untranslated | -         | -         | -         |       |
| 747 | .claude/skills/oidc-compliance/SKILL.md                                | Untranslated | -         | -         | -         |       |
| 748 | .claude/skills/oidc-compliance/specs/enterprise/ciba.md                | Untranslated | -         | -         | -         |       |
| 749 | .claude/skills/oidc-compliance/specs/enterprise/rfc7643-scim-schema.md | Untranslated | -         | -         | -         |       |
| 750 | .claude/skills/oidc-compliance/specs/oauth2/rfc6749-core.md            | Untranslated | -         | -         | -         |       |
| 751 | .claude/skills/oidc-compliance/specs/oauth2/rfc7009-revocation.md      | Untranslated | -         | -         | -         |       |
| 752 | .claude/skills/oidc-compliance/specs/oauth2/rfc7636-pkce.md            | Untranslated | -         | -         | -         |       |
| 753 | .claude/skills/oidc-compliance/specs/oauth2/rfc7662-introspection.md   | Untranslated | -         | -         | -         |       |
| 754 | .claude/skills/oidc-compliance/specs/oauth2/rfc8628-device-flow.md     | Untranslated | -         | -         | -         |       |
| 755 | .claude/skills/oidc-compliance/specs/oidc/core-1.0.md                  | Untranslated | -         | -         | -         |       |
| 756 | .claude/skills/oidc-compliance/specs/oidc/discovery-1.0.md             | Untranslated | -         | -         | -         |       |
| 757 | .claude/skills/oidc-compliance/specs/openid4vc/openid4vci.md           | Untranslated | -         | -         | -         |       |
| 758 | .claude/skills/oidc-compliance/specs/openid4vc/openid4vp.md            | Untranslated | -         | -         | -         |       |
| 759 | .claude/skills/oidc-compliance/specs/openid4vc/rfc9901-sd-jwt.md       | Untranslated | -         | -         | -         |       |
| 760 | .claude/skills/oidc-compliance/specs/security/fapi-2.0.md              | Untranslated | -         | -         | -         |       |
| 761 | .claude/skills/oidc-compliance/specs/security/rfc9101-jar.md           | Untranslated | -         | -         | -         |       |
| 762 | .claude/skills/oidc-compliance/specs/security/rfc9126-par.md           | Untranslated | -         | -         | -         |       |
| 763 | .claude/skills/oidc-compliance/specs/security/rfc9449-dpop.md          | Untranslated | -         | -         | -         |       |

---

## Excluded Files (i18n - intentional multilingual support)

The following files are excluded from translation as they are part of the internationalization system:

- `packages/ar-ui/src/i18n/**/*` - UI internationalization
- `packages/ar-lib-core/src/errors/messages/**/*` - Error message translations
