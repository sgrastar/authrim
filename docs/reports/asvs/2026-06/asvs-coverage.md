# ASVS Monthly Coverage Report - 2026-06

OWASP ASVS v5.0.0 Level 1

Source: https://github.com/OWASP/ASVS/raw/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv

Scope: Initial ASVS v5.0.0 Level 1 Authentication, Session Management, and OAuth Authorization Server coverage trial.

Assessment basis: This is an Authrim self-assessment report. It records evidence coverage for the
listed OWASP ASVS requirements and is not a third-party audit, certification, or penetration-test
attestation.

Generated at: 2026-06-16T15:04:33.394Z

## Table of Contents

- [Executive Summary](#executive-summary)
- [Status by Chapter](#status-by-chapter)
- [Open Gaps](#open-gaps)
- [Manual Review](#manual-review)
- [Control Summary](#control-summary)
- [Requirement Coverage Matrix](#requirement-coverage-matrix)
- [Referenced Tests and Checks](#referenced-tests-and-checks)

## Executive Summary

| Metric | Value |
| --- | ---: |
| Controls | 24 |
| Applicable controls | 19 |
| Evidence covered | 15 |
| Manual review | 1 |
| Not applicable | 5 |
| Gaps | 3 |
| Applicable coverage | 78.95% |
| Total coverage | 62.5% |

## Status by Chapter

| Chapter | Controls | Evidence covered | Manual | N/A | Gaps |
| --- | ---: | ---: | ---: | ---: | ---: |
| V6 | 13 | 7 | 1 | 5 | 0 |
| V7 | 6 | 4 | 0 | 0 | 2 |
| V10 | 5 | 4 | 0 | 0 | 1 |

## Open Gaps

| req_id | section_name | Title | Current assessment |
| --- | --- | --- | --- |
| V7.2.4 | Fundamental Session Management Security | New session token after authentication | Standard authentication handlers create a new session token, but anonymous upgrade flows update an existing session instead of always issuing a new session token and terminating the old token. |
| V7.4.2 | Session Termination | Account disable or deletion terminates sessions | Authrim has an explicit admin endpoint to revoke all sessions for a user, but the user deletion/update handlers do not currently show an automatic call to that revocation path when an account is disabled or deleted. |
| V10.4.4 | OAuth Authorization Server | Client-specific grant restrictions | Authrim validates response_type against client response_types and has profile/client flags for some grants, but authorization_code and refresh_token token endpoint paths do not consistently enforce client-specific grant_types. |

## Manual Review

| req_id | section_name | Title | Current assessment |
| --- | --- | --- | --- |
| V6.1.1 | Authentication Documentation | Authentication Documentation | Rate limiting is implemented for reusable directory-password credentials, but the ASVS-specific documentation set should be reviewed before marking this covered. |

## Control Summary

| Control | Status | Evidence | Title |
| --- | --- | ---: | --- |
| v5.0.0-V6.1.1 | Manual | 3 | Authentication Documentation |
| v5.0.0-V6.2.1 | Not applicable | 2 | Password minimum length |
| v5.0.0-V6.2.2 | Not applicable | 1 | Password change |
| v5.0.0-V6.2.3 | Not applicable | 1 | Password change requires current password |
| v5.0.0-V6.2.4 | Not applicable | 2 | Common password blocklist |
| v5.0.0-V6.2.5 | Not applicable | 1 | Password composition |
| v5.0.0-V6.2.6 | Evidence covered | 1 | Password field masking |
| v5.0.0-V6.2.7 | Evidence covered | 1 | Password paste and managers |
| v5.0.0-V6.2.8 | Evidence covered | 2 | Exact password verification |
| v5.0.0-V6.3.1 | Evidence covered | 2 | Credential attack controls |
| v5.0.0-V6.3.2 | Evidence covered | 4 | Default accounts |
| v5.0.0-V6.4.1 | Evidence covered | 3 | Initial passwords and activation codes |
| v5.0.0-V6.4.2 | Evidence covered | 2 | Password hints and knowledge-based authentication |
| v5.0.0-V7.2.1 | Evidence covered | 3 | Backend session token verification |
| v5.0.0-V7.2.2 | Evidence covered | 3 | Dynamic session tokens |
| v5.0.0-V7.2.3 | Evidence covered | 3 | Reference token entropy |
| v5.0.0-V7.2.4 | Gap | 3 | New session token after authentication |
| v5.0.0-V7.4.1 | Evidence covered | 3 | Session termination invalidates further use |
| v5.0.0-V7.4.2 | Gap | 2 | Account disable or deletion terminates sessions |
| v5.0.0-V10.4.1 | Evidence covered | 4 | Redirect URI exact allowlist |
| v5.0.0-V10.4.2 | Evidence covered | 3 | Authorization code single use |
| v5.0.0-V10.4.3 | Evidence covered | 3 | Authorization code lifetime |
| v5.0.0-V10.4.4 | Gap | 3 | Client-specific grant restrictions |
| v5.0.0-V10.4.5 | Evidence covered | 4 | Public client refresh token replay protection |

## Requirement Coverage Matrix

| section_name | req_id | Result | Description | Requirement |
| --- | --- | --- | --- | --- |
| Authentication Documentation | V6.1.1 | Manual | test V6.1.1-1, test V6.1.1-2, test V6.1.1-3: Rate limiting is implemented for reusable directory-password credentials, but the ASVS-specific documentation set should be reviewed before marking this covered. | Verify that application documentation defines how controls such as rate limiting, anti-automation, and adaptive response, are used to defend against attacks such as credential stuffing and password brute force. The documentation must make clear how these controls are configured and prevent malicious account lockout. |
| Password Security | V6.2.1 | Not applicable | test V6.2.1-1, test V6.2.1-2: Authrim does not currently provide an Authrim-managed end-user password registration or password-setting flow; directory password verification is delegated to an external connector. | Verify that user set passwords are at least 8 characters in length although a minimum of 15 characters is strongly recommended. |
| Password Security | V6.2.2 | Not applicable | test V6.2.2-1: Authrim does not own user-set passwords in the current passwordless and external-directory-password model. | Verify that users can change their password. |
| Password Security | V6.2.3 | Not applicable | test V6.2.3-1: Authrim does not expose password change functionality for Authrim-managed end-user passwords. | Verify that password change functionality requires the user's current and new password. |
| Password Security | V6.2.4 | Not applicable | test V6.2.4-1, test V6.2.4-2: Authrim does not collect new user-set passwords during account registration or password change. | Verify that passwords submitted during account registration or password change are checked against an available set of, at least, the top 3000 passwords which match the application's password policy, e.g. minimum length. |
| Password Security | V6.2.5 | Not applicable | test V6.2.5-1: Authrim does not define or enforce Authrim-managed user password composition rules in the current scope. | Verify that passwords of any composition can be used, without rules limiting the type of characters permitted. There must be no requirement for a minimum number of upper or lower case characters, numbers, or special characters. |
| Password Security | V6.2.6 | Evidence covered | test V6.2.6-1: The Login UI directory password field is rendered with type=password. | Verify that password input fields use type=password to mask the entry. Applications may allow the user to temporarily view the entire masked password, or the last typed character of the password. |
| Password Security | V6.2.7 | Evidence covered | test V6.2.7-1: The Login UI directory password input does not block paste and advertises current-password autocomplete. | Verify that "paste" functionality, browser password helpers, and external password managers are permitted. |
| Password Security | V6.2.8 | Evidence covered | test V6.2.8-1, test V6.2.8-2: Directory password login preserves the password string without trimming or case conversion before forwarding it to the connector. | Verify that the application verifies the user's password exactly as received from the user, without any modifications such as truncation or case transformation. |
| General Authentication Security | V6.3.1 | Evidence covered | test V6.3.1-1, test V6.3.1-2: Reusable directory-password credentials are protected by the strict rate-limit profile. | Verify that controls to prevent attacks such as credential stuffing and password brute force are implemented according to the application's security documentation. |
| General Authentication Security | V6.3.2 | Evidence covered | test V6.3.2-1, test V6.3.2-2, test V6.3.2-3, test V6.3.2-4: Independent ASVS checks verify that setup/migration paths do not seed default accounts and that first-admin creation requires setup-token flow which is disabled after completion. | Verify that default user accounts (e.g., "root", "admin", or "sa") are not present in the application or are disabled. |
| Authentication Factor Lifecycle and Recovery | V6.4.1 | Evidence covered | test V6.4.1-1, test V6.4.1-2, test V6.4.1-3: Independent ASVS checks verify setup-token entropy, TTL, status, expiry, and usage tracking; Authrim uses passkey setup rather than long-term initial passwords. | Verify that system generated initial passwords or activation codes are securely randomly generated, follow the existing password policy, and expire after a short period of time or after they are initially used. These initial secrets must not be permitted to become the long term password. |
| Authentication Factor Lifecycle and Recovery | V6.4.2 | Evidence covered | test V6.4.2-1, test V6.4.2-2: Independent ASVS checks scan runtime authentication, management API, login UI, and migrations for password-hint and knowledge-based authentication surfaces. | Verify that password hints or knowledge-based authentication (so-called "secret questions") are not present. |
| Fundamental Session Management Security | V7.2.1 | Evidence covered | test V7.2.1-1, test V7.2.1-2, test V7.2.1-3: Runtime session validation routes sharded session identifiers to the backend SessionStore and enforces server-side existence, expiration, and revocation checks. | Verify that the application performs all session token verification using a trusted, backend service. |
| Fundamental Session Management Security | V7.2.2 | Evidence covered | test V7.2.2-1, test V7.2.2-2, test V7.2.2-3: Authrim uses dynamically generated reference session identifiers which route to SessionStore state instead of using static API keys or shared secrets as sessions. | Verify that the application uses either self-contained or reference tokens that are dynamically generated for session management, i.e. not using static API secrets and keys. |
| Fundamental Session Management Security | V7.2.3 | Evidence covered | test V7.2.3-1, test V7.2.3-2, test V7.2.3-3: Session identifiers use a 16-byte CSPRNG random component, yielding 128 bits of entropy, before adding routing metadata. | Verify that if reference tokens are used to represent user sessions, they are unique and generated using a cryptographically secure pseudo-random number generator (CSPRNG) and possess at least 128 bits of entropy. |
| Fundamental Session Management Security | V7.2.4 | Gap | test V7.2.4-1, test V7.2.4-2, test V7.2.4-3: Standard authentication handlers create a new session token, but anonymous upgrade flows update an existing session instead of always issuing a new session token and terminating the old token. | Verify that the application generates a new session token on user authentication, including re-authentication, and terminates the current session token. |
| Session Termination | V7.4.1 | Evidence covered | test V7.4.1-1, test V7.4.1-2, test V7.4.1-3: Logout invalidates backend SessionStore state, expiration is enforced during backend lookup, and persistence tombstones prevent stale deleted sessions from being resurrected. | Verify that when session termination is triggered (such as logout or expiration), the application disallows any further use of the session. For reference tokens or stateful sessions, this means invalidating the session data at the application backend. Applications using self-contained tokens will need a solution such as maintaining a list of terminated tokens, disallowing tokens produced before a per-user date and time or rotating a per-user signing key. |
| Session Termination | V7.4.2 | Gap | test V7.4.2-1, test V7.4.2-2: Authrim has an explicit admin endpoint to revoke all sessions for a user, but the user deletion/update handlers do not currently show an automatic call to that revocation path when an account is disabled or deleted. | Verify that the application terminates all active sessions when a user account is disabled or deleted (such as an employee leaving the company). |
| OAuth Authorization Server | V10.4.1 | Evidence covered | test V10.4.1-1, test V10.4.1-2, test V10.4.1-3, test V10.4.1-4: Authorization and token endpoints validate redirect URI format, require client-specific registered redirect URI matches, and compare the token request redirect URI with the value bound to the authorization code. | Verify that the authorization server validates redirect URIs based on a client-specific allowlist of pre-registered URIs using exact string comparison. |
| OAuth Authorization Server | V10.4.2 | Evidence covered | test V10.4.2-1, test V10.4.2-2, test V10.4.2-3: AuthorizationCodeStore atomically marks codes as used, detects replay, and the token endpoint revokes previously issued token JTIs where recorded. | Verify that, if the authorization server returns the authorization code in the authorization response, it can be used only once for a token request. For the second valid request with an authorization code that has already been used to issue an access token, the authorization server must reject a token request and revoke any issued tokens related to the authorization code. |
| OAuth Authorization Server | V10.4.3 | Evidence covered | test V10.4.3-1, test V10.4.3-2, test V10.4.3-3: Authorization code TTL defaults to 60 seconds, below the ASVS L1 10-minute maximum, and expiration is enforced during code consumption. | Verify that the authorization code is short-lived. The maximum lifetime can be up to 10 minutes for L1 and L2 applications and up to 1 minute for L3 applications. |
| OAuth Authorization Server | V10.4.4 | Gap | test V10.4.4-1, test V10.4.4-2, test V10.4.4-3: Authrim validates response_type against client response_types and has profile/client flags for some grants, but authorization_code and refresh_token token endpoint paths do not consistently enforce client-specific grant_types. | Verify that for a given client, the authorization server only allows the usage of grants that this client needs to use. Note that the grants 'token' (Implicit flow) and 'password' (Resource Owner Password Credentials flow) must no longer be used. |
| OAuth Authorization Server | V10.4.5 | Evidence covered | test V10.4.5-1, test V10.4.5-2, test V10.4.5-3, test V10.4.5-4: Public-client refresh token use requires DPoP binding, refresh token rotation is enabled by default, and replay/theft detection revokes the refresh token family. | Verify that the authorization server mitigates refresh token replay attacks for public clients, preferably using sender-constrained refresh tokens, i.e., Demonstrating Proof of Possession (DPoP) or Certificate-Bound Access Tokens using mutual TLS (mTLS). For L1 and L2 applications, refresh token rotation may be used. If refresh token rotation is used, the authorization server must invalidate the refresh token after usage, and revoke all refresh tokens for that authorization if an already used and invalidated refresh token is provided. |

## Referenced Tests and Checks

| Test ID | req_id | Result | Description | Evidence |
| --- | --- | --- | --- | --- |
| V6.1.1-1 | V6.1.1 | Evidence check passed | ASVS scope notes contain required documentation anchors for rate limiting, anti-automation, and malicious account lockout prevention. | docs/testing/asvs-v5-l1-auth-notes.md |
| V6.1.1-2 | V6.1.1 | Reference | Directory password login uses the strict rate-limit profile. | packages/ar-auth/src/index.ts:255 |
| V6.1.1-3 | V6.1.1 | Reference | Rate limiting is documented as enabled by default. | docs/ENVIRONMENT_VARIABLES.md:104 |
| V6.2.1-1 | V6.2.1 | Reference | Initial admin setup is documented as passwordless passkey/WebAuthn. | docs/getting-started/deployment.md:403 |
| V6.2.1-2 | V6.2.1 | Reference | Current scope notes document the absence of Authrim-managed password lifecycle flows. | docs/testing/asvs-v5-l1-auth-notes.md:11 |
| V6.2.2-1 | V6.2.2 | Reference | Self-managed password change/reset endpoints are absent. | docs/testing/asvs-v5-l1-auth-notes.md:11 |
| V6.2.3-1 | V6.2.3 | Reference | Self-managed password change/reset endpoints are absent. | docs/testing/asvs-v5-l1-auth-notes.md:11 |
| V6.2.4-1 | V6.2.4 | Reference | Initial admin setup is passwordless. | docs/getting-started/deployment.md:403 |
| V6.2.4-2 | V6.2.4 | Reference | Password change/reset endpoints are absent. | docs/testing/asvs-v5-l1-auth-notes.md:11 |
| V6.2.5-1 | V6.2.5 | Reference | Authrim is currently passwordless plus external directory password verification. | docs/testing/asvs-v5-l1-auth-notes.md:11 |
| V6.2.6-1 | V6.2.6 | Reference | Directory password input is configured with type=password. | packages/ar-login-ui/src/routes/login/+page.svelte:640 |
| V6.2.7-1 | V6.2.7 | Reference | Directory password input has autocomplete=current-password and no paste blocker. | packages/ar-login-ui/src/routes/login/+page.svelte:640 |
| V6.2.8-1 | V6.2.8 | Reference | Username is trimmed, but password is preserved as the received string. | packages/ar-auth/src/directory-password-login.ts:84 |
| V6.2.8-2 | V6.2.8 | Reference | Connector request body uses input.password directly. | packages/ar-auth/src/directory-password.ts:107 |
| V6.3.1-1 | V6.3.1 | Reference | Directory password login applies strict rate limiting. | packages/ar-auth/src/index.ts:255 |
| V6.3.1-2 | V6.3.1 | Reference | Rate-limit tests cover the strict profile. | packages/ar-lib-core/src/middleware/__tests__/rate-limit.test.ts:712 |
| V6.3.2-1 | V6.3.2 | Evidence check passed | Migrations and setup source do not seed enabled root/admin/sa default user accounts. | 111 migration/setup files scanned |
| V6.3.2-2 | V6.3.2 | Evidence check passed | Initial admin setup requires a setup token, rejects already-initialized systems, and permanently disables setup after completion. | packages/ar-auth/src/setup.ts; packages/ar-lib-core/src/utils/setup-token.ts |
| V6.3.2-3 | V6.3.2 | Reference | First administrator is created during deployment setup with passkey registration. | docs/getting-started/deployment.md:403 |
| V6.3.2-4 | V6.3.2 | Reference | Setup API is permanently disabled after the first admin account is created. | packages/ar-auth/src/index.ts:548 |
| V6.4.1-1 | V6.4.1 | Evidence check passed | Setup token generation uses 32 random bytes and all storage paths enforce expiring setup tokens. | packages/ar-lib-core/src/utils/setup-token.ts; scripts/setup-keys.sh; packages/setup/src/core/admin.ts |
| V6.4.1-2 | V6.4.1 | Evidence check passed | Admin UI passkey setup tokens are random UUIDs, start pending, expire, and have status/usage tracking. | packages/ar-auth/src/setup.ts; packages/ar-lib-core/src/repositories/base.ts; migrations/admin/002_admin_policy_relationships.sql |
| V6.4.1-3 | V6.4.1 | Reference | Initial administrator setup uses passkey/WebAuthn rather than a long-term initial password. | docs/getting-started/deployment.md:403 |
| V6.4.2-1 | V6.4.2 | Evidence check passed | Auth runtime, management API, login UI, and migrations expose no password-hint or knowledge-based authentication surfaces. | 308 runtime/schema files scanned |
| V6.4.2-2 | V6.4.2 | Reference | Initial admin setup is passwordless and does not describe password hints or knowledge-based authentication. | docs/getting-started/deployment.md:403 |
| V7.2.1-1 | V7.2.1 | Evidence check passed | Session tokens are verified through backend SessionStore lookup with format, expiry, and revocation checks. | packages/ar-auth/src/direct-auth.ts; packages/ar-lib-core/src/durable-objects/SessionStore.ts |
| V7.2.1-2 | V7.2.1 | Reference | validateSession rejects invalid session identifiers and loads session state from SessionStore. | packages/ar-auth/src/direct-auth.ts:607 |
| V7.2.1-3 | V7.2.1 | Reference | SessionStore getSession enforces expiration and user-level revocation. | packages/ar-lib-core/src/durable-objects/SessionStore.ts:551 |
| V7.2.2-1 | V7.2.2 | Evidence check passed | Authentication handlers create dynamic reference session tokens through the SessionStore sharding helper instead of static API secrets or keys. | packages/ar-lib-core/src/utils/session-helper.ts; packages/ar-auth/src/direct-auth.ts; packages/ar-auth/src/email-code.ts; packages/ar-auth/src/anon-login.ts; packages/ar-auth/src/directory-password-login.ts |
| V7.2.2-2 | V7.2.2 | Reference | generateRegionShardedSessionId creates a new sharded reference session identifier. | packages/ar-lib-core/src/utils/session-helper.ts:65 |
| V7.2.2-3 | V7.2.2 | Reference | Direct authentication creates sessions through getSessionStoreForNewSession. | packages/ar-auth/src/direct-auth.ts:2161 |
| V7.2.3-1 | V7.2.3 | Evidence check passed | Reference session tokens include a 16-byte CSPRNG random component, giving 128 bits of entropy. | packages/ar-lib-core/src/utils/session-helper.ts; packages/ar-lib-core/src/utils/crypto.ts |
| V7.2.3-2 | V7.2.3 | Reference | generateSecureSessionId uses 16 random bytes from crypto.getRandomValues. | packages/ar-lib-core/src/utils/crypto.ts:347 |
| V7.2.3-3 | V7.2.3 | Reference | Region-sharded session IDs embed the CSPRNG random part. | packages/ar-lib-core/src/utils/session-helper.ts:77 |
| V7.2.4-1 | V7.2.4 | Reference | Anonymous upgrade intentionally reuses the existing session identifier. | packages/ar-auth/src/email-code.ts:550 |
| V7.2.4-2 | V7.2.4 | Reference | Upgrade completion updates the existing session data and user ID. | packages/ar-auth/src/upgrade.ts:451 |
| V7.2.4-3 | V7.2.4 | Reference | Standard direct authentication creates a new session through getSessionStoreForNewSession. | packages/ar-auth/src/direct-auth.ts:2161 |
| V7.4.1-1 | V7.4.1 | Evidence check passed | Logout and session-store invalidation remove backend session state and guard against cold-persistence resurrection. | packages/ar-auth/src/logout.ts; packages/ar-auth/src/direct-auth.ts; packages/ar-lib-core/src/durable-objects/SessionStore.ts |
| V7.4.1-2 | V7.4.1 | Reference | RP-initiated logout invalidates the current sharded session in SessionStore. | packages/ar-auth/src/logout.ts:381 |
| V7.4.1-3 | V7.4.1 | Reference | invalidateSession deletes cache, Durable Object storage, and cold persistence, creating tombstones on persistence-delete failure. | packages/ar-lib-core/src/durable-objects/SessionStore.ts:680 |
| V7.4.2-1 | V7.4.2 | Reference | adminUserRevokeAllSessionsHandler records a revocation epoch, invalidates located SessionStore sessions, and deletes persisted sessions. | packages/ar-management/src/admin-user-sessions.ts:571 |
| V7.4.2-2 | V7.4.2 | Reference | Admin user deletion deletes the user and invalidates cache, but does not show automatic all-session revocation. | packages/ar-management/src/admin-users.ts:1010 |
| V10.4.1-1 | V10.4.1 | Evidence check passed | OAuth redirect URIs are format-validated, require exact registration matches, and are rebound during authorization-code redemption. | packages/ar-auth/src/authorize.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/utils/validation.ts |
| V10.4.1-2 | V10.4.1 | Reference | Authorization endpoint checks redirect_uri against registered client redirect URIs. | packages/ar-auth/src/authorize.ts:2027 |
| V10.4.1-3 | V10.4.1 | Reference | isRedirectUriRegistered uses exact string comparison. | packages/ar-lib-core/src/utils/validation.ts:911 |
| V10.4.1-4 | V10.4.1 | Reference | Token endpoint rejects redirect_uri values that differ from the authorization code binding. | packages/ar-token/src/token.ts:1656 |
| V10.4.2-1 | V10.4.2 | Evidence check passed | Authorization codes are short-lived, atomically marked used, and replay attempts trigger invalid_grant handling with token revocation where possible. | packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/utils/oauth-config.ts |
| V10.4.2-2 | V10.4.2 | Reference | consumeCode checks expiration and replay before atomically marking the code used. | packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts:558 |
| V10.4.2-3 | V10.4.2 | Reference | Token endpoint handles authorization-code replay and revokes issued tokens where possible. | packages/ar-token/src/token.ts:1564 |
| V10.4.3-1 | V10.4.3 | Evidence check passed | Authorization codes are short-lived, atomically marked used, and replay attempts trigger invalid_grant handling with token revocation where possible. | packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/utils/oauth-config.ts |
| V10.4.3-2 | V10.4.3 | Reference | AUTH_CODE_TTL defaults to 60 seconds. | packages/ar-lib-core/src/utils/oauth-config.ts:85 |
| V10.4.3-3 | V10.4.3 | Reference | Stored authorization codes receive expiresAt based on CODE_TTL. | packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts:536 |
| V10.4.4-1 | V10.4.4 | Reference | Authorization endpoint validates response_type against client response_types. | packages/ar-auth/src/authorize.ts:1722 |
| V10.4.4-2 | V10.4.4 | Reference | Token endpoint routes supported grant_type values, but authorization_code dispatch is not gated by client grant_types. | packages/ar-token/src/token.ts:1187 |
| V10.4.4-3 | V10.4.4 | Reference | refresh_token grant has tenant-profile validation, but no client grant_types check is visible here. | packages/ar-token/src/token.ts:2772 |
| V10.4.5-1 | V10.4.5 | Evidence check passed | Public-client refresh tokens are sender-constrained with DPoP, rotated by default, and stale-token replay revokes the token family. | packages/ar-token/src/token.ts; packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts; packages/ar-lib-core/src/utils/oauth-config.ts |
| V10.4.5-2 | V10.4.5 | Reference | Public client refresh tokens must be DPoP-bound. | packages/ar-token/src/token.ts:3004 |
| V10.4.5-3 | V10.4.5 | Reference | Refresh token rotation is enabled by default and uses RefreshTokenRotator. | packages/ar-token/src/token.ts:3183 |
| V10.4.5-4 | V10.4.5 | Reference | RefreshTokenRotator rejects expired/revoked families and detects stale token versions. | packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts:512 |
