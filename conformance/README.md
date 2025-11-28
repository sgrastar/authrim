# Authrim OpenID Connect Certification Status

## Table of Contents

- [Core Profiles](#core-profiles)
- [Dynamic OP](#dynamic-op)
- [Form Post Profiles](#form-post-profiles)
- [Flow Profiles](#flow-profiles)
- [RP-Initiated Logout](#rp-initiated-logout)
- [Frontchannel-RP-Initiated Logout](#frontchannel-rp-initiated-logout)
- [Backchannel-RP-Initiated Logout](#backchannel-rp-initiated-logout)
- [Session Management](#session-management)
- [3rd Party Initiated Login](#3rd-party-initiated-login)
- [FAPI Profiles](#fapi-profiles)

---

## Core Profiles

| Profile | Status | Result |
|---------|--------|--------|
| Basic OP | ✅ Passed | 34/38 (30 passed, 4 skipped) |
| Config OP | ✅ Passed | 1/1 (100%) |

### Basic OP - Skipped Tests (Expected)

The following tests are intentionally skipped (unsigned tokens/objects not supported for security):

| Test | Reason |
|------|--------|
| oidcc-idtoken-unsigned | Unsigned ID Token not supported |
| oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported | Unsigned Request URI not supported |
| oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported | Unsigned Request Object not supported |
| oidcc-ensure-request-object-with-redirect-uri | Request Object not supported |

## Dynamic OP

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## Form Post Profiles

| Profile | Status |
|---------|--------|
| Form Post Basic | ⏳ Pending |
| Form Post Hybrid | ⏳ Pending |
| Form Post Implicit | ⏳ Pending |

## Flow Profiles

| Profile | Status |
|---------|--------|
| Hybrid OP | ⏳ Pending |
| Implicit OP | ⏳ Pending |

## RP-Initiated Logout

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## Frontchannel-RP-Initiated Logout

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## Backchannel-RP-Initiated Logout

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## Session Management

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## 3rd Party Initiated Login

| Response Type | Status |
|---------------|--------|
| code | ⏳ Pending |
| code id_token | ⏳ Pending |
| code id_token token | ⏳ Pending |
| code token | ⏳ Pending |
| id_token | ⏳ Pending |
| id_token token | ⏳ Pending |

## FAPI Profiles

| Profile | Variant | Status |
|---------|---------|--------|
| FAPI 2.0 Security Profile | private_key_jwt / dpop / simple / openid_connect / plain_fapi | ⏳ Pending |
| FAPI 2.0 Security Profile | private_key_jwt / dpop / rar / openid_connect / plain_fapi | ⏳ Pending |
| FAPI-CIBA-ID1 | private_key_jwt / ping / plain_fapi | ⏳ Pending |
| FAPI-CIBA-ID1 | private_key_jwt / poll / plain_fapi | ⏳ Pending |

---

## Status Legend

| Icon | Meaning |
|------|---------|
| ✅ | Passed |
| 🔄 | Testing |
| ⏳ | Pending |
| ❌ | Failed |

---

## Quick Links

- [OpenID Certification Portal](https://www.certification.openid.net/)
- [Conformance Test Automation Scripts](./scripts/)

---

> **Last Updated:** 2025-11-28
