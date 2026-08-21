---
project: Authrim
lang: en
date: 2026-08-21
description: "OpenID4VP 1.0 Final and OpenID4VCI 1.0 Final with HAIP 1.0 gap analysis."
type: test-report
tags:
  - oid4vp
  - oid4vci
  - haip
  - conformance
---

# OIDF OpenID4VC Final and HAIP gap analysis (2026-08-21)

## Scope

This is an implementation gap analysis, not certification evidence. It uses the current official
OpenID Foundation Conformance Suite plan names and Final/HAIP variants against a newly provisioned,
tenant-exclusive conformance tenant:

- Tenant ID: `oid4vc-final-haip`
- Origin: `https://oid4vc-final-haip.conformance.authrim.com`
- OID4VCI plan: `oid4vci-1_0-issuer-test-plan`
- OID4VP plan: `oid4vp-1final-verifier-test-plan`
- Credential format: `sd_jwt_vc`

Each official plan ran its representative happy-flow module. The repository also contains a
fail-closed variant matrix and a live metadata gap analyzer under `scripts/oidf-conformance-gate`.

## Current result

| Profile | Plan ID | Module ID | Suite result | Current boundary |
| --- | --- | --- | --- | --- |
| OID4VCI 1.0 Final | `Vwa6C71vi7pW1` | `keuE72CkHq9Yfup` | `INTERRUPTED / FAILED` | Metadata, PAR, authorization, token HTTP 200, and DPoP passed; OAuth-only token response incorrectly included an ID token |
| OID4VCI 1.0 Final + HAIP 1.0 | `WMABOSIhGXaJ4` | `w80g0k3yyfNjbAK` | `INTERRUPTED / FAILED` | Missing credential-configuration `scope`; OAuth client-attestation PAR returned 401 |
| OID4VP 1.0 Final | `89DUIgUiiNeAy` | `mUmKrVwMYX5tswr` | `FINISHED / FAILED` | Final authorization-request requirements and VP direct-post processing fail |
| OID4VP 1.0 Final + HAIP 1.0 | `SGLZ7FTlcBf2n` | `lCtK7sm9GBoaZWv` | `INTERRUPTED / FAILED` | No signed `request_uri`; Authrim emitted the plain query/direct-post profile |

## Verified support

- The isolated tenant provisions successfully with dedicated core/default, core/users, and PII D1
  databases.
- Credential Issuer metadata is reachable and tenant-bound.
- `dc+sd-jwt`, JWT proof, nonce endpoint, and DPoP algorithms are advertised.
- In the OID4VCI Final representative flow, Suite metadata validation, static
  `private_key_jwt` client authentication, PAR, browser authorization, authorization-code callback,
  token endpoint HTTP 200, access-token extraction, refresh-token validation, and DPoP all passed.
- Verifier metadata advertises DCQL, `dc+sd-jwt`, `direct_post`, and `direct_post.jwt`.
- Authrim can create and persist a VP request and deliver it to the Suite wallet.

## Confirmed gaps

### OID4VCI Final

- The profile is `plain_oauth`, but Authrim returns an ID token in the successful token response.
  The Suite stops at `ExpectNoIdTokenInTokenResponse` before it can call the credential endpoint.
- The standard Login UI rendered an `invalid_request` error instead of TOTP controls for the valid
  authorization challenge. The direct TOTP API completed the same challenge and consent flow,
  confirming that the protocol flow could continue while the UI runtime path could not.

### OID4VCI HAIP

- `AuthrimIdentityCredential` does not advertise a non-empty `scope`. The Suite reports this as a
  HAIP Section 4.1 failure.
- Authorization Server metadata does not advertise `attest_jwt_client_auth`.
- A PAR request carrying `OAuth-Client-Attestation` and `OAuth-Client-Attestation-PoP` is rejected
  with HTTP 401; the Suite expected HTTP 201.

### OID4VP Final

- Authrim emits the removed `client_id_scheme` parameter.
- Authrim supports only the `pre-registered` client identifier scheme. The Final
  `redirect_uri:` identifier requirement is not implemented, so `client_id` does not match
  `response_uri` after removing the prefix.
- `client_metadata.vp_formats` is missing.
- Authrim generates a 64-character nonce; the Suite warns that values over 43 characters can reduce
  wallet interoperability.
- The Suite-generated valid `dc+sd-jwt` response is rejected by `/vp/response` with HTTP 400,
  `AR130003`.

### OID4VP HAIP

- `x509_hash` is not advertised or accepted as a client identifier prefix.
- Authrim does not generate a signed request object delivered through `request_uri`.
- Authrim initiates `direct_post` instead of the selected HAIP `direct_post.jwt` variant, even though
  verifier metadata advertises `direct_post.jwt`.

## Local checks

The live metadata analyzer reported 5 passing and 4 failing capability checks. The failing checks
were credential-configuration scope, OAuth client-attestation advertisement, Final `redirect_uri`
client identifier support, and HAIP `x509_hash` support.

Commands:

```sh
pnpm conformance:test
pnpm conformance:typecheck
OIDF_OPENID4VC_TARGET_ORIGIN=https://oid4vc-final-haip.conformance.authrim.com \
  pnpm conformance:openid4vc:metadata
```

At the time of this report, the reusable gate tests pass: 3 files, 24 tests.
