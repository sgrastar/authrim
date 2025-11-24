# OpenID Connect Conformance Tests 🔐

This folder contains test suites for OpenID Connect compliance and certification.

**Goal:** Pass all tests to obtain OpenID Foundation certification.

---

## 📋 Test Coverage

### OpenID Connect Core Tests

| # | Test Profile | Status | Description | Certification |
|---|--------------|--------|-------------|---|
| 1 | **Basic Certification Profile** | ⏳ Not Started | Authorization Code flow with standard endpoints | **Required** |
| 2 | **Config Certification Profile** | ⏳ Not Started | Provider configuration via `.well-known/openid-configuration` | **Required** |
| 3 | **Dynamic Certification Profile** | ⏳ Not Started | Dynamic Client Registration (RFC 7591) support | **Required** |
| 4 | **Form Post Basic Certification Profile** | ⏳ Not Started | Form Post Response Mode for Authorization Code flow | **Required** |
| 5 | **Form Post Hybrid Certification Profile** | ⏳ Not Started | Form Post Response Mode for Hybrid flow | **Recommended** |
| 6 | **Form Post Implicit Certification Profile** | ⏳ Not Started | Form Post Response Mode for Implicit flow | **Recommended** |
| 7 | **Hybrid Certification Profile** | ⏳ Not Started | Hybrid flow with multiple response types | **Recommended** |
| 8 | **Implicit Certification Profile** | ⏳ Not Started | Implicit flow (legacy, not recommended for new implementations) | **Optional** |
| 9 | **Rp Initiated Logout Certification Profile** | ⏳ Not Started | RP-Initiated Logout per OpenID Connect Session Management | **Recommended** |
| 10 | **Session Management Certification Profile** | ⏳ Not Started | Session management and OP-initiated logout | **Recommended** |
| 11 | **3rd Party Initiated Login Certification Profile** | ⏳ Not Started | Login initiation from third-party websites | **Optional** |

### FAPI Tests

| # | Test Profile | Status | Description | Certification |
|---|--------------|--------|-------------|---|
| 12 | **FAPI-CIBA-ID1** | ⏳ Not Started | FAPI Client Initiated Backchannel Authentication | **Enterprise** |
| 13 | **FAPI2-Security-Profile-Final** | ⏳ Not Started | Financial-grade API (FAPI) 2.0 Security Profile | **Enterprise** |

---

## 📊 Overall Status

- **Total Tests:** 13
- **Completed:** 0 ✅
- **In Progress:** 0 🔄
- **Not Started:** 13 ⏳
- **Pass Rate:** 0%

---

## 🎯 Recommended Implementation Order

### Phase 1: Core Certification (Required - 4 tests)
1. Basic Certification Profile
2. Config Certification Profile
3. Dynamic Certification Profile
4. Form Post Basic Certification Profile

**Target:** OpenID Certification - Basic OP profile

### Phase 2: Enhanced Certification (Recommended - 4 tests)
5. Hybrid Certification Profile
6. Form Post Hybrid Certification Profile
7. Rp Initiated Logout Certification Profile
8. Session Management Certification Profile

**Target:** Enhanced OpenID Certification

### Phase 3: Extended Support (Optional/Enterprise - 5 tests)
9. Form Post Implicit Certification Profile
10. Implicit Certification Profile
11. 3rd Party Initiated Login Certification Profile
12. FAPI-CIBA-ID1
13. FAPI2-Security-Profile-Final

**Target:** Advanced features for enterprise adoption

---

## 📁 Test Folders

Each test profile has its own folder:

- `OIDC Basic OP/` - Basic Authorization Code flow
- `OIDC Config OP/` - Configuration discovery
- `OIDC Dynamic OP/` - Dynamic Client Registration
- `OIDC Form Post OP/` - Form Post Response Mode (Basic)
- `OIDC Form Post Hybrid OP/` - Form Post Response Mode (Hybrid)
- `OIDC Form Post Implicit OP/` - Form Post Response Mode (Implicit)
- `OIDC Hybrid OP/` - Hybrid flow
- `OIDC Implicit OP/` - Implicit flow
- `OIDC RP-Initiated Logout OP/` - RP-Initiated Logout
- `OIDC Session Management OP/` - Session Management
- `OIDC 3rd Party Initiated Login OP/` - 3rd Party Initiated Login
- `OIDC FAPI-CIBA-ID1/` - FAPI Client Initiated Backchannel Authentication
- `OIDC FAPI2.0 Security Profile/` - FAPI 2.0 Security Profile

---

## 🚀 Getting Started

1. **Set up test environment** - Configure local Authrim instance
2. **Run conformance suite** - Execute tests against your provider
3. **Fix failing tests** - Address any spec violations
4. **Document results** - Record pass/fail status for each test
5. **Submit for certification** - Apply to OpenID Foundation

---

## 📚 References

- [OpenID Connect Conformance Suite](https://www.openid.net/certification/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1-0.html)
- [OpenID Connect Session Management 1.0](https://openid.net/specs/openid-connect-session-1_0.html)
- [Financial-grade API (FAPI) 2.0 Security Profile](https://openid.net/specs/openid-financial-api-part-2-ID2.html)

---

## ✅ Certification Targets

### Basic OpenID Provider Certification
- [x] Basic Certification Profile
- [x] Config Certification Profile
- [x] Dynamic Certification Profile
- [x] Form Post Basic Certification Profile

**Status:** Core requirements for OpenID certification

### Enhanced Certification
- [ ] Hybrid Certification Profile
- [ ] Form Post Hybrid Certification Profile
- [ ] Rp Initiated Logout Certification Profile
- [ ] Session Management Certification Profile

**Status:** Additional profiles for enhanced certification

### Enterprise & Advanced
- [ ] Form Post Implicit Certification Profile
- [ ] Implicit Certification Profile
- [ ] 3rd Party Initiated Login Certification Profile
- [ ] FAPI-CIBA-ID1
- [ ] FAPI2-Security-Profile-Final

**Status:** Extended support for enterprise features

---

> **Last Updated:** 2025-11-25
> **Target Completion:** Q1 2026
