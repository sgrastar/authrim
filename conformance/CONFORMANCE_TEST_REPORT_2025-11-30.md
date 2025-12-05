# OIDC Conformance Test Report

**Execution Date:** 2025-11-30
**Purpose:** Execute 4 representative tests and identify major bugs

---

## Executive Summary

| Test Plan | Pass Rate | Passed | Failed | Warnings | Skipped |
|-------------|--------|------|------|------|----------|
| OIDC Basic OP | 78.95% | 30 | 2 | 1 | 1 |
| OIDC Implicit OP | 91.38% | 53 | 2 | 0 | 0 |
| OIDC Hybrid OP | 81.37% | 83 | 6 | 3 | 0 |
| OIDC Dynamic OP (code) | 17.39% | 4 | 11 | 1 | 1 |

**Overall Assessment:** Basic/Implicit/Hybrid flows achieved high pass rates. Dynamic profile has critical issues with `private_key_jwt` authentication.

---

## 1. OIDC Basic OP Certification

**Plan ID:** akkSb8eWeHpwc
**Execution Time:** 2025-11-29T22:11:08.605Z
**Test Count:** 38

### Test Results

#### ✅ Passed Tests (30)

| Test ID | Test Name |
|----------|----------|
| UWZ79GIPnvhHXua | oidcc-server |
| tK3ov3gMzN9tvzJ | oidcc-idtoken-signature |
| dTRIakTRYR6vDu5 | oidcc-userinfo-get |
| R6bgvTZUMoSXJJA | oidcc-userinfo-post-header |
| KnvBnZbDiyedS3W | oidcc-userinfo-post-body |
| csmL5eZJZqMuAAn | oidcc-ensure-request-without-nonce-succeeds-for-code-flow |
| lyjDqJh2xoU5cRd | oidcc-scope-profile |
| tWFo6Cr13y57JyI | oidcc-scope-email |
| FGwCu438Y9tYCex | oidcc-scope-address |
| HPIQKP2Pj9wfVEk | oidcc-scope-phone |
| NAMqrtS0Mi2wJE2 | oidcc-scope-all |
| CoQq4BIn8oZ5eD0 | oidcc-ensure-other-scope-order-succeeds |
| i5onNfvwtIPuCwc | oidcc-display-page |
| 1TK3YbfNzNa5xYd | oidcc-display-popup |
| JuBNrZkzDvzyaD8 | oidcc-prompt-none-not-logged-in |
| 7sUehB68nbNrmG8 | oidcc-prompt-none-logged-in |
| guxiIEOsDXPkeBS | oidcc-ensure-request-with-unknown-parameter-succeeds |
| fViNyGRBcNKbGzT | oidcc-id-token-hint |
| P0e4GT9y4oBrg22 | oidcc-login-hint |
| qhDqT5ffBpP29GA | oidcc-ui-locales |
| wRUCL4ZkbPeh9sQ | oidcc-claims-locales |
| 5MNy1jolRjUrV8m | oidcc-ensure-request-with-acr-values-succeeds |
| QXO43965PHEDaG1 | oidcc-codereuse |
| yEw5EYWljNfUgCB | oidcc-ensure-post-request-succeeds |
| eG1uVVtdmxJTEZW | oidcc-server-client-secret-post |
| FmkrQJos4nn0S74 | oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported |
| 6ukltCOUtmWNuxB | oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported |
| JZh83GwGpGL6yuY | oidcc-claims-essential |
| eqYaY1CA7Zcjn0r | oidcc-refresh-token |
| lfmB8n2Avg29s42 | oidcc-ensure-request-with-valid-pkce-succeeds |

#### ❌ Failed Tests (2)

| Test ID | Test Name | Cause | Classification |
|----------|----------|------|------|
| oidcc-max-age-10000 | oidcc-max-age-10000 | Unknown | Needs Investigation |
| kH5IQ6nb5aLSY9d | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | Test Runner Error |

#### ⚠️ Warnings (1)

| Test ID | Test Name | Condition | Message |
|----------|----------|------|-----------|
| o0rI8RcLTMh6BMT | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |

#### 👀 Awaiting Review (4)

- nPk7T54CrhGTmXr: oidcc-response-type-missing
- u6lj4kypX6WU2nV: oidcc-prompt-login
- Zdymv5JGXfhiqxh: oidcc-max-age-1
- uipSYwAkGCNNafH: oidcc-ensure-registered-redirect-uri

---

## 2. OIDC Implicit OP Certification

**Plan ID:** 5ytteGe8lJWEj
**Execution Time:** 2025-11-29T22:37:00.877Z
**Test Count:** 58

### Test Results

#### ✅ Passed Tests (53)

Main test categories:
- **Server Basic Functionality:** oidcc-server (2 times)
- **ID Token Signature:** oidcc-idtoken-signature (2 times)
- **Scope Processing:** profile, email, address, phone, all (2 times each)
- **Display Mode:** page, popup (2 times each)
- **Prompt Processing:** login, none-not-logged-in, none-logged-in
- **max-age Processing:** max-age-1, max-age-10000
- **UserInfo:** get, post-header, post-body
- **Other:** claims-essential, request-object, request-uri

#### ❌ Failed Tests (2)

| Test ID | Test Name | Cause | Classification |
|----------|----------|------|------|
| e1NBtltKGChqSeR | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | Test Runner Error |
| nq8Mq7C2LJ7HMnS | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | Test Runner Error |

**Note:** These are not OP bugs, but issues with the Conformance Suite test runner. The OP correctly rejects requests without nonce.

---

## 3. OIDC Hybrid OP Certification

**Plan ID:** qc6eaFCIL8Ifu
**Execution Time:** 2025-11-29T23:11:54.952Z
**Test Count:** 102

### Test Results

#### ✅ Passed Tests (83)

For 3 response_types (`code id_token`, `code token`, `code id_token token`):
- Server basic functionality
- ID Token signature
- UserInfo (GET/POST header/POST body)
- Scope processing (profile, email, address, phone, all)
- Display mode (page, popup)
- Prompt processing (none-not-logged-in, none-logged-in)
- max-age processing (10000)
- claims-essential
- request-uri, request-object
- refresh-token
- client-secret-post

#### ❌ Failed Tests (6)

| Test ID | Test Name | Cause | Classification |
|----------|----------|------|------|
| pLhiFdjfKhm2X5K | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | Test Runner Error |
| RqY4529HA441R1I | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | Test Runner Error |
| Fkxs92Hm3JAg5n0 | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | Test Runner Error |
| sijskpiZ3KvmUwd | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | Test Runner Error |
| zyVfdmTCTFbqbS5 | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | Test Runner Error |
| **13Q5a2Qj9eQwPKk** | **oidcc-ensure-request-without-nonce-succeeds-for-code-flow** | **The authorization was expected to succeed** | **🐛 OP Bug** |

#### ⚠️ Warnings (3)

| Test ID | Test Name | Condition | Message |
|----------|----------|------|-----------|
| 8iuj8OuY4ROzi5W | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |
| pi2UGpi2x2cH8O9 | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |
| iiTKZEdicMo5N10 | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |

### 🐛 Identified Bug: Nonce Validation

**Test:** `oidcc-ensure-request-without-nonce-succeeds-for-code-flow`
**response_type:** `code token`

**Issue:** OP requires nonce even for `response_type=code token`

**OIDC Specification:** nonce is only required when `id_token` is included in the authorization response
- `code` → nonce not required
- `code token` → nonce not required ← **Current OP incorrectly requires nonce**
- `code id_token` → nonce required
- `code id_token token` → nonce required

---

## 4. OIDC Dynamic OP (code)

**Plan ID:** M6HFFZG9CBCqf
**Execution Time:** 2025-11-30T00:35:36.732Z
**Test Count:** 23

### Test Results

#### ✅ Passed Tests (4)

| Test ID | Test Name |
|----------|----------|
| Ml8vPaQUo9cDvf2 | oidcc-redirect-uri-regfrag |
| 12qSF3GsSYctlDS | oidcc-registration-sector-uri |
| C7lNXAz8YPQ3mV7 | oidcc-server-rotate-keys |
| JyvXCoaf5FczhAW | oidcc-request-uri-signed-rs256 |

#### ❌ Failed Tests (11)

| Test ID | Test Name | Cause | Classification |
|----------|----------|------|------|
| ftBqA1O5aImYYcj | oidcc-idtoken-rs256 | Error from the token endpoint | 🐛 Token Endpoint |
| mj4GwF06ioyiTW8 | oidcc-userinfo-rs256 | userinfo_signing_alg_values_supported: not found | 🐛 Discovery |
| 9wxI0InZJHYScrV | oidcc-redirect-uri-query-OK | Error from the token endpoint | 🐛 Token Endpoint |
| RkDK2NwbHXMSMIs | oidcc-discovery-endpoint-verification | response_types/grant_types missing | 🐛 Discovery |
| gGx0wRIMlSlOaSP | oidcc-server | Error from the token endpoint | 🐛 Token Endpoint |
| fi1C386GyXJ0nyJ | oidcc-registration-jwks-uri | Error from the token endpoint | 🐛 Token Endpoint |
| 2jvMvswUYxkKD5R | oidcc-registration-sector-bad | unexpected http status | 🐛 Registration |
| 0AbeReYmXTuQBRW | oidcc-refresh-token-rp-key-rotation | Error from the token endpoint | 🐛 Token Endpoint |
| hpSEq2V43vdCLFg | oidcc-request-uri-unsigned | Error from the token endpoint | 🐛 Token Endpoint |
| oS95qTG6wnS72mR | oidcc-ensure-request-object-with-redirect-uri | Error from the token endpoint | 🐛 Token Endpoint |
| L1MREWmd1qWpYrP | oidcc-refresh-token | Error from the token endpoint | 🐛 Token Endpoint |

#### ⚠️ Warnings (1)

| Test ID | Test Name | Condition | Message |
|----------|----------|------|-----------|
| 4coXRMqGYp4buv0 | oidcc-ensure-client-assertion-with-iss-aud-succeeds | CheckIfTokenEndpointResponseError | token endpoint call was expected to succeed, but returned error |

---

## Identified Bugs

### 🔴 Critical (Must Fix)

#### 1. Token Endpoint - private_key_jwt Authentication Failure

**Impact:** Majority of Dynamic OP tests (8/11 failures)
**Symptoms:** All token requests from dynamically registered clients fail
**Suspected Cause:** Issue with `private_key_jwt` client authentication implementation

**Investigation Points:**
- `client_assertion` JWT verification logic
- `client_assertion_type` processing
- JWKS retrieval for dynamically registered clients

#### 2. Discovery Endpoint - Missing Required Fields

**Impact:** `oidcc-discovery-endpoint-verification`, `oidcc-userinfo-rs256`
**Missing Fields:**
- `userinfo_signing_alg_values_supported` (does not exist)
- `response_types_supported` (missing required types)
- `grant_types_supported` (missing required types)

### 🟡 High (Recommended Fix)

#### 3. Nonce Validation - code token Flow

**Impact:** `oidcc-ensure-request-without-nonce-succeeds-for-code-flow`
**Symptoms:** Incorrectly requires nonce for `response_type=code token`
**Fix:** Limit nonce requirement to "when id_token is included in authorization response"

#### 4. Dynamic Registration - Error Response

**Impact:** `oidcc-registration-sector-bad`
**Symptoms:**
- Returns status other than 400 for invalid `sector_identifier_uri`
- Error response missing `error` field

### 🟢 Low (Investigation Needed)

#### 5. codereuse-30seconds Warning

**Impact:** Basic, Hybrid OP (warnings only)
**Symptoms:** UserInfo endpoint does not return 4xx for code reuse test after 30 seconds
**Note:** May depend on test specification interpretation

---

## Test Runner Issues

The following are not OP bugs, but Conformance Suite issues:

| Issue | Affected Tests |
|------|-----------|
| Illegal test state change: FINISHED -> RUNNING | oidcc-ensure-request-without-nonce-fails (multiple) |
| runInBackground called after runFinalisation | oidcc-ensure-request-object-with-redirect-uri (multiple) |

---

## Fix Priority

1. **Token Endpoint (private_key_jwt)** - Affects majority of Dynamic OP tests
2. **Discovery Endpoint (userinfo_signing_alg_values_supported)** - Easy fix
3. **Nonce Validation (code token)** - OIDC specification compliance
4. **Registration Error Response** - Improved error handling

---

## Next Steps

### Phase 1: Critical Bug Fixes
1. Investigate and fix private_key_jwt authentication
2. Add missing fields to Discovery Endpoint

### Phase 2: High Priority Fixes
3. Fix nonce validation logic
4. Fix Registration error responses

### Phase 3: Re-test
5. Re-run the 4 representative tests
6. Execute remaining test plans:
   - formpost-* series
   - logout-related (rp-logout, frontchannel, backchannel)
   - session-management
   - 3rdparty-login
   - fapi-2, fapi-ciba

---

## Appendix: Test Execution Commands

```bash
# Basic OP
npx tsx run-conformance.ts --spec specs/basic-op.json

# Implicit OP
npx tsx run-conformance.ts --spec specs/implicit-op.json

# Hybrid OP
npx tsx run-conformance.ts --spec specs/hybrid-op.json

# Dynamic OP (code)
npx tsx run-conformance.ts --spec specs/dynamic-op-code.json
```

---

**Report Created by:** Authrim Conformance Test Automation
**Creation Date:** 2025-11-30
