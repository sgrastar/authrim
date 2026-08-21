# OIDF RP Conformance Runbook (2026-08)

This document records the Authrim RP certification setup, the successful baseline
settings, and the failure modes found while rerunning the official OpenID Foundation
Conformance Suite in the `conformance` environment.

## Scope

The target is RP certification only. **Basic OP is out of scope and must not be run.**

The RP profiles in scope are:

- Basic RP
- Config RP
- Dynamic RP
- Form Post Basic RP
- RP-Initiated Logout Basic
- Back-Channel Logout Basic
- FAPI-CIBA Poll and Ping
- FAPI 2 OP Final profiles
- FAPI 2 RP Final profiles
- FAPI 2 Client Credentials

FAPI 1.0 and draft profiles are excluded. Front-Channel Logout is intentionally not
included because it would require maintaining the iframe endpoint.

## Environment and stable settings

- Conformance origin: `https://conformance.authrim.com`
- RP tenant for Basic, Config, Dynamic, Form Post, and logout profiles:
  `oidc-basic-rp`
- FAPI 2 OIDC RP tenant: `fapi2-final-rp`
- FAPI 2 plain OAuth RP tenant: `fapi2-final-rp-oauth`
- FAPI 2 Message Signing JAR tenant: `fapi2-ms-final-rp-jar`
- FAPI 2 Message Signing JARM tenant: `fapi2-ms-final-rp-jar` (shared temporarily because
  the dedicated JARM tenant remained blocked in provisioning)
- FAPI-CIBA tenant: `fapi-ciba`
- Suite publication setting: `publish: "everything"`
- Basic, Config, Form Post, and logout clients: static client
- Dynamic RP client: dynamic registration with `client_secret_basic`
- FAPI 2 RP and Message Signing RP clients: static client objects supplied in the
  Suite plan configuration. The historical plans do not display an explicit
  `client_registration=static_client` variant, but their module logs contain
  `Found a static client object` for every module; do not convert these runs to
  dynamic registration.
- Important distinction: the Suite-side FAPI RP registration mode is static, but
  the local runner provisions the temporary static client records through DCR and
  then uses their returned `client_id`/JWKS. In other words, July and August were
  not FAPI `dynamic_client` plans; DCR was only the provisioning mechanism for the
  static client objects.
- FAPI-CIBA Poll/Ping: `client_registration=static_client`, matching the prior
  certification plan configuration.
- Default-tenant DCR was enabled temporarily for a comparison run and restored to
  its prior disabled state after the run.
- Redirect callback for the Basic RP runner:
  `https://oidc-basic-rp.conformance.authrim.com/auth/external/oidf-basic-rp/callback`
- Internal driver callback:
  `https://oidc-basic-rp.conformance.authrim.com/rp-test-complete`
- Default tenant DCR: restore to its normal value after any diagnostic change; it is
  not a substitute for the RP tenant's DCR configuration.

The conformance runner recreates an ephemeral machine principal with `admin:*` for
each run and removes it during cleanup. Tokens, private keys, TOTP values, Suite
tokens, and client secrets must never be copied into this document or terminal output.

## RP submission evidence requirements

The authoritative OIDF guidance is:

- [Conformance Testing for OpenID Connect RPs](https://openid.net/certification/connect_rp_testing/)
- [Submission of Results for FAPI RPs](https://openid.net/certification/fapi_rp_submission/)
- [How to submit your certification request](https://openid.net/certification/how-to-submit-your-certification-request/)
- [Certification Submission Examples](https://openid.net/wordpress-content/uploads/2019/11/Certification-Submission-Examples.pdf)

For each RP test module, retain at least one client-evidence file. The file name must
start with the exact OIDF test name; if the same test is run for more than one response
type, append the response type to make each file unique. A client log is preferred for
the automated Authrim driver. A screenshot may be used instead (or in addition) when
the test is interactive. Negative tests must show that the RP detected and handled the
invalid condition; a generic HTTP trace or a Suite PASS line alone is insufficient.

The local staging layout mirrors the evidence portion of an OIDF package:

```text
<result>/client-data/
  oidcc-client-test-....log
  fapi2-security-profile-final-client-test-....log
  manifest.json
```

`client-data` is generated from the sanitized Authrim Diagnostic Logging export. It
contains only minimal request/response decisions and validation outcomes; raw tokens,
authorization codes, cookies, client secrets, private keys, and JWTs are rejected by the
export validation. `evidence/` is retained as the source/staging copy, while
`client-data/` is the directory to inspect when preparing the Suite's certification
package.

OIDF also requires every test to be `FINISHED`; `FAILED` and `INTERRUPTED` results
cannot be certified, while `WARNING` is acceptable. For the current submission flow,
run **Publish for certification** for each plan, upload the client-data zip for RP
profiles, and download the Suite-generated result ZIP. Do not create the old
`OpenID-Certification-of-Conformance.pdf` manually at this stage.

The current flow at `https://submissions.openid.net/` collects the Entity, Deployment,
Payment Code, declaration, and contact information. The Suite-generated result ZIPs
are uploaded under `Exported Test Results`. After the form is submitted, the signer
receives a DocuSign request for the generated Declaration of Conformance. The request
is not processed until that document is signed. Because supplied logs are published,
deactivate temporary clients and revoke test keys immediately before submission.
Keep one or more evidence files per exact test name; do not merge all tests into one
generic log.

For FAPI RP profiles, client evidence must show the RP behavior and, for negative
modules, the detection of the tested invalid condition. A Suite PASS line or generic
HTTP trace alone is insufficient. Sanitized logs should show only the relevant
validation decision and must exclude tokens, codes, cookies, keys, and secrets.

### RP log packaging checklist

Before opening **Publish for certification**, verify for every executed RP module:

1. The Suite module is `FINISHED` and is not `FAILED` or `INTERRUPTED`.
2. `client-data/` contains a separate file whose basename starts with the exact Suite
   test name. Do not use a translated display name or shortened alias.
3. The file shows the RP's observable decision: successful validation for positive tests,
   or the expected rejection and reason for negative tests.
4. The file contains no token, code, DPoP proof, cookie value, private key, client secret,
   email address, or raw JWT.
5. `manifest.json` records the exact test name, Suite module ID, status, and evidence file.
   Skipped modules are recorded as skipped; no client log is fabricated for them.
6. The Suite's published test log remains paired with the same plan. Do not combine
   evidence from a failed plan with a later plan unless OIDF explicitly permits it.

The local exporter enforces the secret-free rule and writes sanitized evidence under
`client-data/`. Keep raw Suite logs and pre-sanitization diagnostic exports private;
only the generated client-data zip is intended for the OIDF submission.

### RP evidence packages currently staged

Verified on 2026-08-20, the following completed RP plans have a separate sanitized
`client-data/` directory and `manifest.json`. Each executed module has one log whose
basename begins with the exact Suite test name; skipped modules are listed only in the
manifest.

| Profile | Plan | Executed logs | Skipped | Package |
| --- | --- | ---: | ---: | --- |
| Basic RP | `zmdPLGDg2mCIk` | 13 | 1 | `OIDC RP Basic/results/2026-08-19_004607_143/client-data/` |
| Config RP | `R9lwZ9K9K0upj` | 5 | 1 | `OIDC RP Config/results/2026-08-19_004833_831/client-data/` |
| Dynamic RP | `p0GTtKb8UEYKL` | 11 | 1 | `OIDC RP Dynamic/client-data/` |
| Form Post Basic RP | `j576sTwO6j9X8` | 13 | 1 | `OIDC RP Form Post Basic/results/2026-08-19_005200_829/client-data/` |
| RP-Initiated Logout Basic | `f4ILPzr0HTSuG` | 3 | 0 | `OIDC RP RP-Initiated Logout Basic/results/2026-08-21_013632_790/client-data/` |
| Back-Channel Logout Basic | `YGlyYLvn5dSrZ` | 8 | 0 | `OIDC RP Back-Channel Logout Basic/results/2026-08-21_013801_496/client-data/` |
| FAPI 2 RP OpenID Connect | `dB1BQRGdg30Or` | 22 | 0 | `FAPI2 RP Final private key DPoP OpenID Connect/results/2026-08-20_104944_133/client-data/` |
| FAPI 2 RP private key + DPoP | `fywPzSuQMaXYI` | 10 | 0 | `FAPI2 RP Final private key DPoP/results/2026-08-20_105402_010/client-data/` |
| FAPI 2 Message Signing JAR RP | `WwYiyugdCFkFp` | 10 | 0 | `FAPI2 MS RP Final JAR/results/2026-08-20_105604_439/client-data/` |
| FAPI 2 Message Signing JARM RP | `Qp9TW2GG0Pvf0` | 16 | 0 | `FAPI2 MS RP Final JARM/results/2026-08-20_105904_801/client-data/` |

The staged files passed the local secret scan: no raw JWT, private key, bearer token,
client secret, access/refresh token, session cookie, or `Set-Cookie` value was found.
These ZIPs are suitable as the client-data staging input. The Suite-generated result
ZIP must still be created through **Publish for certification** and then attached to
the current OIDF submission form. The Declaration of Conformance is generated by the
form and signed through DocuSign.

The current completed runs have the following individual-log counts:

| Run | Client logs | Notes |
| --- | ---: | --- |
| Basic RP | 13 | 1 SKIPPED module excluded |
| Config RP | 5 | 1 SKIPPED module excluded |
| Form Post Basic RP | 13 | 1 SKIPPED module excluded |
| FAPI 2 RP OIDC | 22 | Clean final plan |
| FAPI 2 RP private_key_jwt + DPoP | 10 | Clean final plan |
| FAPI 2 Message Signing RP JAR | 10 | All modules passed |
| FAPI 2 Message Signing RP JARM | 16 | All modules passed |

Dynamic RP is ready for evidence review. Its sanitized diagnostic export contains one
exact-name client log per executed module plus `manifest.json`. The WebFinger and
Dynamic Registration modules run on the Suite side, so the exporter records their pass
decision as a secret-free `oidf_suite_client_trace` log rather than fabricating an
Authrim request trace. RP-Initiated Logout and the complete eight-module Back-Channel
Logout package are also staged in the table above.

Before submission, use the Suite's **Publish for certification** flow for each profile,
download the Suite-generated result ZIP, and attach it to the current OIDF submission
form. Deactivate/revoke test clients and keys because supplied logs are published. A profile is not ready when
any module is `FAILED` or `INTERRUPTED`; `PASS`, `REVIEW`, `WARNING`, and `SKIPPED` are
acceptable under the OIDF RP guidance.

## Known-good RP baselines

These were completed with the same `publish: "everything"` publication mode:

| Profile            | Plan            | Result                    |
| ------------------ | --------------- | ------------------------- |
| Basic RP           | `3Pc2poSPYfVh0` | 13 PASS / 1 SKIP / 0 FAIL |
| Config RP          | `4eZgCrzaHSNVH` | 5 PASS / 1 SKIP / 0 FAIL  |
| Form Post Basic RP | `JywJoFFmNDTDQ` | 13 PASS / 1 SKIP / 0 FAIL |
| Dynamic RP         | `5SfbcSiMP58yJ` | 11 PASS / 1 SKIP / 0 FAIL |

The current Config rerun also completed successfully:

- Plan: `4iBRD6v4vt55k`
- 5 PASS / 1 SKIP / 0 FAIL
- Result directory: `private/conformance/OIDC RP Config/results/2026-08-18_225226_828`

The current Form Post rerun completed successfully before the final deployment
refresh:

- Plan: `xQnFLerLXIPkj`
- 13 PASS / 1 SKIP / 0 FAIL
- Result directory: `private/conformance/OIDC RP Form Post Basic/results/2026-08-18_222736_840`

The current Dynamic RP rerun completed successfully after correcting the DCR flow:

- Plan: `5SfbcSiMP58yJ`
- 11 PASS / 1 SKIP / 0 FAIL
- Result directory: `private/conformance/OIDC RP Dynamic/results/2026-08-18_233519_475`

Historical FAPI RP baselines confirmed during the registration-mode audit:

- FAPI 2 Final RP (OpenID Connect): plan `MBpeMQ0eCJBjQ`, 22/22 PASS;
  every module log identified a static client object.
- FAPI 2 Final RP (plain OAuth): plan `DLQAHM5l69qjf`, 10/10 PASS;
  every module log identified a static client object.
- FAPI 2 Message Signing JAR: plan `nBaGy68X8ppAx`, 10/10 PASS;
  every module log identified a static client object.
- FAPI 2 Message Signing JARM: plan `4AIdzmHZwYMRw`, 16/16 PASS;
  every module log identified a static client object.

## Current rerun results (2026-08-19)

The following current runs completed with `publish: "everything"`:

| Profile                        | Plan            | Result                                                                                                               | Outcome                           |
| ------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Basic RP                       | `zmdPLGDg2mCIk` | `OIDC RP Basic/results/2026-08-19_004607_143`                                                                        | 13 PASS / 1 SKIP / 0 FAIL         |
| Config RP                      | `R9lwZ9K9K0upj` | `OIDC RP Config/results/2026-08-19_004833_831`                                                                       | 5 PASS / 1 SKIP / 0 FAIL          |
| Dynamic RP                     | `4C55I2EIMibKs` | `OIDC RP Dynamic/results/2026-08-19_004944_266`                                                                      | 11 PASS / 1 SKIP / 0 FAIL         |
| Form Post Basic RP             | `j576sTwO6j9X8` | `OIDC RP Form Post Basic/results/2026-08-19_005200_829`                                                              | 13 PASS / 1 SKIP / 0 FAIL         |
| FAPI 2 RP OIDC                 | `E7EKAQB1lIM2o` | `FAPI2 RP Final private key DPoP OpenID Connect/results/2026-08-19_010419_286` + failed-only resume `.../012300_042` | 22 PASS / 0 SKIP / 0 FAIL overall |
| FAPI 2 RP plain OAuth          | `3Xq7FyTW4BQbX` | `FAPI2 RP Final private key DPoP/results/2026-08-19_011122_880` + failed-only resume `.../012335_752`                | 10 PASS / 0 SKIP / 0 FAIL overall |
| FAPI 2 Message Signing RP JAR  | `gt2bTQagigRfY` | `FAPI2 MS RP Final JAR/results/2026-08-19_022401_925`                                                                | 10 PASS / 0 SKIP / 0 FAIL         |
| FAPI 2 Message Signing RP JARM | `gy0ZMcgw9vK9P` | `FAPI2 MS RP Final JARM/results/2026-08-19_025846_279`                                                               | 16 PASS / 0 SKIP / 0 FAIL         |

Dynamic RP evidence package:

- Suite result: `OIDC RP Dynamic/results/2026-08-19_215127_630`
- Staging directory: `OIDC RP Dynamic/client-data`
- Evidence source: `OIDC RP Dynamic/results/2026-08-19_215127_630/evidence`
- Contents: 11 sanitized client logs and `manifest.json`; the single SKIPPED module is
  recorded in the manifest and has no client log requirement.

The two FAPI 2 RP and the JAR runs initially had one discovery-issuer-mismatch
failure. Each failed module was rerun against the same plan with the persisted
FAPI key pair; the supplementary run passed. The JARM run passed all modules on
the final attempt. The dedicated `fapi2-ms-final-rp-jarm` tenant was not used
because its Control operation remained in `waiting_retry`.

FAPI 2 Client Credentials (the additional requested test) also completed earlier:
plan `R3ObeHZ5mIv92`, 13 PASS / 1 SKIP / 0 FAIL.

The July FAPI 2 OP logs explicitly say `Provisioning temporary FAPI static
clients...` and later delete those clients. The July FAPI 2 Message Signing OP
run has the same sequence. Thus the answer is: yes, the July runner used DCR to
create the temporary client records, but the OIDF plan itself was a
`static_client` style test configuration; it was not a `dynamic_client` profile.
The August runner preserves that same distinction.

## Current incomplete profiles

- FAPI-CIBA Poll: final rerun with the real TOTP user, synchronized approval
  capability, and temporary `loadTest` rate-limit override passed 35/35 in plan
  `arxqDmGlw0w8F`. Result directory:
  `OIDC OP FAPI-CIBA-ID1 private_key_jwt poll plain_fapi/results/2026-08-18_1906`.
  The earlier partial runs are retained only as diagnostic history.
- FAPI-CIBA Ping: final rerun with the same real user and approval capability
  passed 40/40 in plan `dviYHmj5KPBZP`. Result directory:
  `OIDC OP FAPI-CIBA-ID1 private_key_jwt ping plain_fapi/results/2026-08-18_1858`.
  The earlier partial runs are retained only as diagnostic history.
- RP-Initiated Logout Basic: completed separately with 3/3 PASS in plan
  `oAeYcH4nVJwSN`; evidence is staged under
  `OIDC RP RP-Initiated Logout Basic/results/2026-08-19_234946_535/client-data`.
- Back-Channel Logout Basic: the complete eight-module run passed and is staged under
  `OIDC RP Back-Channel Logout Basic/results/2026-08-20_034605_644/client-data`.
  The older timeout and single-module diagnostic runs remain excluded.

### 2026-08-20 RP logout diagnostic notes

The browser automation now records only secret-free evidence needed to diagnose this
case: Discovery `return_to` origin/path and query-key names, authentication API status
and response-key names, cookie names by host, and `/api/sessions/status` active state.
The RP-initiated logout rejection diagnostic additionally records boolean session and
provider-field presence flags; it does not record session IDs, provider IDs, tokens, or
cookie values. The diagnostic exporter must be run with a fresh short-lived admin token
and its output remains private until sanitized into a flow-scoped `client-data` log.

The direct discovery-grant path remains enabled because the ordinary Discovery UI
cannot leave the root page in this environment. It is not sufficient by itself for
Back-Channel Logout: a passing submission requires all eight modules to complete and
to show the provider-bound logout flow in their client evidence.
- Latest RP-Initiated Logout browser retries after the explicit TOTP handoff:
  plans `TPon4gSmMqS3d` and `dE1DIaUrrSlfv` both reached the Suite authorization
  endpoint, but the Authrim callback redirected to `callback_failed`. The second
  attempt ended as `INTERRUPTED/FAILED` for module `UyasKoZpXBbDgPW` because the
  Suite saw a duplicate token request with existing client authentication. TOTP
  was entered successfully; this is not evidence of an invalid TOTP code.
- Latest Back-Channel Logout plan `O9lXPCRALJGb5` created all 8 modules, but the
  first module `3t4mnsd6lp5WPPB` reached `rpFlowStatus=403` and logout `401`,
  then timed out before a Suite terminal result. The local run therefore has no
  current pass summary.
- Fresh-user confirmation on 2026-08-19: RP-Initiated Logout plan
  `NkP52Ja1kBNqz` and Back-Channel Logout plan `0FOP8sbK1yvqn` both reached
  `rpFlowStatus=403` and Logout `401` before the Suite module timeout. The
  temporary RP user and rate-limit override were removed afterward. This rules
  out the earlier stale-user and rate-limit hypotheses, but is not a pass.
- FAPI 2 OP Final and FAPI 2 Message Signing OP Final are OP results, not RP
  client-data packages. The older plans `ci9Kafo5bZUsm` and `n7bbgbjWkcBgX` below
  are historical diagnostic runs only. The final 2026-08-20 reruns are recorded
  separately and have zero failed modules.

### 2026-08-20 FAPI 2 OP PAR reuse investigation

The July full run `CFsKyzaEQpFDh` passed
`fapi2-security-profile-final-par-ensure-reused-request-uri-prior-to-auth-completion-succeeds`.
Its observable browser order was: open the first authorization URL and reach the login
page, acknowledge the Suite visit, save the login-page evidence, open the same
`request_uri` again, then authenticate and complete the callback.

The runner was changed to preserve that order. The first-visit browser context contained
only theme/tenant-hint cookies and no Authrim session cookie. The isolated rerun still
failed with the Suite exception that the user was authenticated on the initial visit.
Therefore evidence capture order and a stale browser session are not sufficient
explanations; the current failure is retained as an OP/Suite interaction issue and is
not included in any certification package.

Excluded FAPI 2 OP attempts:

- `hPLrHP6Fcdyzf`: 50/56; four PAR/refresh failures were rate-limit `429` responses.
- `ci9Kafo5bZUsm`: 53/56; the rate-limit override removed the four 429 failures, but
  the single PAR reuse module still failed. One warning and one expected skip remained.
- `Nbfh0XQE9ewJR`: isolated reproduction of the same PAR reuse failure after the
  browser-order correction.

The complete Message Signing OP run was then executed with the same corrected runner:
plan `n7bbgbjWkcBgX`, result directory
`OIDC OP FAPI2.0 Message Signing Final private_key_jwt dpop openid_connect jar jarm/results/2026-08-19_2019`.
It reached 66/70 passed, 2 expected skips, 1 warning, and the same one unexpected
PAR-reuse failure. The temporary `loadTest` override and TOTP user were cleared after
the run. This confirms the blocker is isolated to that OP/Suite interaction and does
not affect the completed RP evidence packages.

These plans are diagnostic history only. They were superseded by the final plans below.

### 2026-08-20 final FAPI 2 OP reruns

The corrected runner acknowledged the initial authorization visit before external
navigation, waited briefly for the Suite visit record to settle, used a fresh browser
context for the PAR-reuse test, and authenticated with TOTP. Both final plans completed
without `FAILED` or `INTERRUPTED` modules:

| Profile | Plan | Result directory | Outcome |
| --- | --- | --- | --- |
| FAPI 2 Security Profile Final | `UBS5Qa3nxkaFX` | `OIDC OP FAPI2.0 Security Profile Final private_key_jwt dpop openid_connect plain_fapi/results/2026-08-20_0029` | 54 PASS / 1 WARNING / 1 SKIP / 0 FAIL |
| FAPI 2 Message Signing Final | `nfhD6hSsMLxqk` | `OIDC OP FAPI2.0 Message Signing Final private_key_jwt dpop openid_connect jar jarm/results/2026-08-20_0102` | 67 PASS / 1 WARNING / 2 SKIP / 0 FAIL |

The previous PAR-reuse failure passed in both final plans. The warnings are the
identity-claims test; the skips are the RS256 negative tests that are not applicable
to the selected configuration. HTML export returned Suite HTTP 404, but the runner
saved the Markdown report, JSON summary, screenshots, and Suite plan evidence. The
temporary FAPI clients were deleted after each run; the temporary rate-limit override,
TOTP user, and admin principal were removed after the final run.

### 2026-08-20 Back-Channel JIT failure and migration repair

The Back-Channel callback passed authorization-code, ID-token, and UserInfo
validation but failed during local JIT account creation. The management Worker
tail showed `provisionExternalIdpAccount` being canceled after the runtime
deadline. The tenant D1 schema was one migration behind the base conformance
database: the draft
`052_consent_records_cross_database_client_reference.sql` had not reached the
Control-managed tenant targets. A conformance-only supported update was run with
`--allow-draft-manifest --all --yes`; Control reported `37/37` targets complete and
15 Workers updated successfully. A subsequent one-module Back-Channel run passed.

The runner now also has a temporary `OIDC_RP_ONLY_MODULE_INDEX` selector so a
specific module in an existing Suite plan can be rerun without creating a new plan.
This is for controlled recovery only. The final package must still come from one
complete plan with every module `FINISHED` and acceptable.

## Operational procedure

1. Run the normal environment update first so every Worker receives the generated
   tenant D1 bindings:

   ```sh
   pnpm run setup update --env conformance --allow-draft-manifest --all --yes
   ```

2. Confirm the generated `ar-bridge` configuration contains the expected conformance
   tenant bindings before starting RP tests.

3. Use a fresh Suite plan for each submission run. Do not reuse a plan whose modules
   are `WAITING` or `INTERRUPTED` after a failed local runner attempt.

4. Keep the exact module result from the Suite as authoritative. A final local HTTP
   status such as `403` or `500` can be the expected end state of a negative test; it
   is not a failure when the Suite module result is `PASSED`.

5. Export the per-test Suite logs and Authrim diagnostic evidence only after all
   modules in the plan are complete. The evidence exporter must be run against the
   completed summary and must not be used to manufacture evidence for a partial plan.

## Mistakes and fixes recorded in this run

### 1. Basic OP was accidentally considered

The target is **Basic RP**, not Basic OP. Any accidental Basic OP plan or result must
be excluded from the certification status and from the all-category count.

### 2. Direct component deployment lost tenant bindings

Deploying `ar-bridge` directly with the generated component config caused:

```text
409 missing_binding
route: /api/external/oidf-basic-rp/start
tenant_id: oidc-basic-rp
```

The fix is to stop using the direct component deployment for this workflow and run the
normal Setup update. Setup refreshes all generated configs and deploys the complete
binding set together.

### 3. Issuer trailing-slash mismatch

The Suite may publish an issuer with a trailing slash while the RP provider record
held the same issuer without it. This caused Authrim ID-token validation to report an
unexpected `iss` claim value during Form Post RP.

The RP runner now reads the exact issuer from successful discovery metadata for normal
modules, while discovery-negative modules retain their intentionally modified issuer.
The OIDC bridge client also normalizes a trailing slash only when constructing the
discovery URL; issuer validation remains exact.

### 4. Dynamic RP used the wrong WebFinger alias

The create-plan response can omit `config.alias`. The runner therefore fell back to
`authrim-oidc-dynamic-rp`, while Suite registered a dated/unique alias. Authrim then
received `webfinger_http_404` from the Suite.

The runner now fetches the complete plan after creation when `config.alias` is absent.
New Dynamic plans also receive a short random suffix so repeated plans on the same
day cannot collide. The WebFinger resource must be derived from that exact plan alias.

### 5. Rate limiting during certification automation

Repeated module setup and diagnostic requests exhausted the conformance environment's
admin rate limit and returned:

```text
429 rate_limit_exceeded
```

For the temporary conformance test window, set the profile override to `loadTest`
with a bounded expiry on both the `default` tenant and the tenant under test. A
default-only override does not remove the target RP tenant's token throttling. Clear
both overrides when certification work is finished so the normal protection is
restored. Do not change production rate limits.

The override endpoint is:

```text
PUT /api/admin/settings/rate-limits/profile-override
{"profile":"loadTest","expires_in":3600}
```

Use an ephemeral `admin:*` token scoped to the conformance environment. After the
testing window, clear it with:

```text
DELETE /api/admin/settings/rate-limits/profile-override
```

### 6. Dynamic RP attempted DCR after a discovery-only module

After the WebFinger fix, the runner explicitly tried Dynamic Client Registration
after `oidcc-client-test-discovery-openid-config` had already finished. Suite then
reported `FINISHED -> RUNNING`, and Authrim surfaced it as `502 Dynamic client
registration failed`.

The runner calls the admin registration endpoint only for the actual
`oidcc-client-test-dynamic-registration` module. The Dynamic Registration quirk is
disabled specifically for `oidcc-client-test-discovery-openid-config`, because that
module completes immediately after discovery and a subsequent automatic DCR causes a
`FINISHED -> RUNNING` state error. The other Dynamic discovery modules retain the
quirk: the JWKS discovery module needs automatic DCR before its authorization request
so that the Suite receives the registered `request_uri` client metadata.

After the actual DCR call, the runner preserves the returned `client_id` and
`client_secret` for subsequent provider updates. Overwriting those values with a
placeholder caused later authorization requests to lose `request_uri` and made the
JWKS discovery module fail.

### 7. FAPI RP tenant runtime provisioning after a worker refresh

The generated conformance bindings currently contain the durable `fapi2` and
`fapi2-cc` tenants, but RP-specific tenants are created by the RP runner. After a
worker refresh, an RP tenant can be present in `provisioning` while its Control
runtime route is not yet published; the public endpoint then returns
`409 missing_generation`. The runner must wait for tenant provisioning to reach
`succeeded` before requesting admin tokens or starting a Suite plan.

On 2026-08-19, creating `fapi2-final-rp-oauth` consumed the daily D1 creation
budget on its final shard. Control left the operation in `waiting_retry` with an
automatic retry scheduled for 09:00 JST. This is an environment readiness issue,
not an OIDF registration-mode issue; do not switch the FAPI RP plan to dynamic
registration to work around it.

For this certification run only, the Control resource policy was temporarily
changed from `daily_d1_create_budget=20` to `40` at 00:40 JST and then to `80`
when the additional RP tenant provisioning exceeded the first temporary limit.
It was restored to `20` after the test runs; the verified `max_d1_resources` value
remained unchanged at `1000`.

### 8. Per-run admin access isolation

The first rerun used the shared setup principal and occasionally lost its admin
session with a 401 during the second WebFinger request. The runner now creates a
unique temporary `automation` principal, client ID, key ID, and key directory per
process, grants only the requested ephemeral `admin:*` access, and removes exactly
that principal and key pair in `finally`. This avoids cross-run cleanup races while
retaining the user-approved temporary admin access.

### 9. FAPI 2 static-client persistence and discovery-negative handling

The RP runner now persists the generated FAPI 2 private key pair by plan ID with
0600 permissions. A failed-only resume loads the same key instead of replacing the
provider-side JWKS with a new key. The runner also treats the
`discovery-issuer-mismatch` module as a negative discovery case and uses the
canonical discovery issuer for that module. This prevents the negative test from
being interrupted by an unrelated PAR/authorization flow and was required for the
16/16 JARM result.

### 10. FAPI 2 OP account/metadata database boundary

The FAPI 2 OP rerun was repeated with a real TOTP user and a temporary `loadTest`
rate-limit override. Login, TOTP verification, session status, and consent GET
all returned 200. The first Allow submission consistently returned:

```text
500 server_error / Failed to process consent
```

The masked diagnostic export showed `POST /auth/consent` -> `500`, followed by
retries returning `Invalid or expired challenge`. Read-only D1 checks showed that
the account/user database contains the canonical `identity_accounts` row, but its
`oauth_clients` table is empty; the tenant metadata database contains the DCR
clients. `oauth_client_consents` in the user database has a foreign key to that
local `oauth_clients` table. Therefore the consent insert cannot reference the
DCR client and the handler falls into its generic 500 response. The same failure
was reproduced on the default tenant with temporary DCR enabled, so this is not
specific to tenant-exclusive provisioning.

This is an environment/runtime data-boundary issue, not a TOTP or static-vs-DCR
configuration issue. Do not mark FAPI 2 OP as passed by skipping consent or by
creating shadow client rows without an explicit, separately documented test
fixture decision.

The current Login UI uses an email input, so the private conformance browser
runner was extended for this run to recognize `input[type="email"]` and
`input[name="email"]`. FAPI 2 TOTP state files without profile fields were run
with explicit defaults `SHA1`, 6 digits, 30 seconds. These are runner/test
changes only; no product worker was changed.

### 2026-08-20 clean RP submission plans

The earlier FAPI 2 RP plans contained an interrupted discovery-negative instance
that was later supplemented by a passed rerun. Because a certification package
must remain coherent, those plans are historical only. The following new plans were
run from scratch after the discovery-negative handling fix:

| Profile | Plan | Result | Evidence |
| --- | --- | --- | --- |
| FAPI 2 RP OIDC | `dB1BQRGdg30Or` | 22 PASS / 0 FAIL | `FAPI2 RP Final private key DPoP OpenID Connect/results/2026-08-20_104944_133/client-data/` |
| FAPI 2 RP private_key_jwt + DPoP / Client Credentials | `fywPzSuQMaXYI` | 10 PASS / 0 FAIL | `FAPI2 RP Final private key DPoP/results/2026-08-20_105402_010/client-data/` |
| FAPI 2 RP JAR | `WwYiyugdCFkFp` | 10 PASS / 0 FAIL | `FAPI2 MS RP Final JAR/results/2026-08-20_105604_439/client-data/` |
| FAPI 2 RP JARM | `Qp9TW2GG0Pvf0` | 16 PASS / 0 FAIL | `FAPI2 MS RP Final JARM/results/2026-08-20_105904_801/client-data/` |

Logout was also rerun after adding Suite image upload to the RP browser runner
(historical; superseded by the clean 2026-08-21 rerun below):

| Profile | Plan | Result | Evidence |
| --- | --- | --- | --- |
| RP-Initiated Logout Basic | `lrmZbgq25CDLc` | 3 REVIEW / 0 FAIL | `OIDC RP RP-Initiated Logout Basic/results/2026-08-20_110430_413/client-data/` |
| Back-Channel Logout Basic | `HdnCWwv5LI1Az` | 8 REVIEW / 0 FAIL | `OIDC RP Back-Channel Logout Basic/results/2026-08-20_110610_284/client-data/` |

Each logout module uploaded browser evidence successfully before the Suite module
was finalized. The Suite marks image-bearing logout modules as `REVIEW`; this is a
human-review result, not a failed or interrupted execution. The uploader stores the
JPEG locally and posts it to the module image endpoint; the Suite's image-list GET
endpoint returns only unresolved placeholders and therefore reports zero after a
successful upload, including for older known-good uploaded logs.

The RP runner now captures a completion-page screenshot when a browser flow reaches
the local completion URL before a login/consent interaction is observable. This
prevents a required image from being silently omitted while retaining the exact
Suite module association. The new clean plans' manifests have zero validation
problems, and the RP evidence/unit checks pass after this change.

### 2026-08-21 clean Logout rerun without Suite image uploads

The Logout runner was corrected to keep browser screenshots only in the private
result directory and to omit optional ad-hoc `ImageAPI` uploads. This is the clean
submission run for the current 0.4.0 evidence set; the 2026-08-20 plans above remain
historical and must not be paired with these new `client-data` artifacts.

| Profile | Plan | Result | Evidence |
| --- | --- | --- | --- |
| RP-Initiated Logout Basic | `f4ILPzr0HTSuG` | 3 PASS / 0 REVIEW / 0 FAIL | `OIDC RP RP-Initiated Logout Basic/results/2026-08-21_013632_790/client-data/` |
| Back-Channel Logout Basic | `YGlyYLvn5dSrZ` | 8 PASS / 0 REVIEW / 0 FAIL | `OIDC RP Back-Channel Logout Basic/results/2026-08-21_013801_496/client-data/` |

All 11 modules finished successfully. The Suite logs contain no `_image-api`
entries, and both generated manifests report zero screenshots. The private result
directories retain local browser captures for troubleshooting, but the two staged
submission ZIPs contain only the 3 and 8 sanitized client logs respectively.

### 11. Logout failure boundary

The RP-Initiated and Back-Channel Logout reruns used a newly prepared TOTP user
and a bounded `loadTest` rate-limit override on `oidc-basic-rp`. Both still
received `rpFlowStatus=403` from the Suite-side discovery/resolve flow and `401`
from Authrim's upstream logout route. The runner reached the Logout URL, but the
Suite module did not reach a terminal result. Do not treat the July successful
Back-Channel result as evidence for this current deployment.

A browser-handoff retry of RP-Initiated Logout used plan `hg3cx2WykT0gu` and
module `vU71UWPB5xtqlPH`, with `publish=everything`. The handoff was not
completed in the browser before the runner timeout, so the module ended
`INTERRUPTED/FAILED` and produced no certification evidence. This result must
not replace the earlier diagnostic finding; a valid rerun still requires
completing the Suite browser visit and then exporting the correlated RP
diagnostic log.

### 12. Latest logout trace and tenant-capacity evidence

The most recent RP-Initiated Logout trace used plans `517gbT79dWA8l` and
`hMBOPNavJMipv`. The Suite authorization, token, ID-token, and UserInfo steps
completed successfully. Authrim then returned a 302 to `login?error=callback_failed`.
The `ar-bridge` Worker tail recorded a generic callback error classified as
`fapi2_validation_failed`; that classification is the common fallback and does
not mean that this was a FAPI 2 test. The subsequent Suite-side flow returned
403 and Authrim's logout endpoint returned 401.

Read-only D1 inspection after the trace found new
`account_creation_operations` in `writing` on the metadata database. The
corresponding account database contained identity-account rows but no current
successful directory publication for the retry. This places the current logout
failure after the external authorization exchange, at local account
provisioning/continuation, rather than at TOTP, discovery, or Suite client
registration.

To avoid contaminating the known-good RP tenant, a fresh diagnostic tenant
`oidc-basic-rp-retry-20260819` was requested. Its provisioning operation remains
`waiting_retry` at `capacity_check` (attempt 16); Control has not assigned its
runtime allocation. The temporary Control policy change was restored and
verified as `daily_d1_create_budget=20`, `max_d1_resources=1000` for the
`conformance` environment. The temporary rate-limit override, setup-principal
tenant scope, diagnostic script, and TOTP state file were removed after the
diagnostic run.

The local RP runner also contains a narrowly scoped continuation handler for the
external provisioning-status endpoint. It was type-checked and handles the
expected 202/resume sequence, but it cannot fix a callback that fails before the
downstream redirect; no pass is claimed from this code path.

The explicit TOTP-confirmed retries used plans `TPon4gSmMqS3d`/`SdDVq9Ym4uzXcyo`
and `dE1DIaUrrSlfv`/`UyasKoZpXBbDgPW`. The browser followed Suite's authorization
redirect and Authrim then returned to the common tenant selector with
`error=callback_failed`. A read-only header trace confirmed the sequence
`/api/external/.../start` -> Suite `/authorize` -> Authrim `/callback` ->
`callback_failed`; the failure occurs before the logout callback and is not
caused by the TOTP entry. The Suite log for the second retry reports a duplicate
token request (`Found existing client authentication`), so that attempt is also
not valid certification evidence.

The subsequent Back-Channel Logout plan `O9lXPCRALJGb5` reproduced the earlier
non-browser boundary: the initial RP flow returned 403 from Suite's
`/discover?/resolve`, Authrim's logout endpoint returned 401, and the module
timed out. After these checks, the temporary `oidc-basic-rp` rate-limit override
and TOTP user were removed and the prior authentication settings were restored.

### 13. 2026-08-19 fresh-tenant retry and current blocker

The fresh tenant `oidc-basic-rp-retry-20260819` was eventually allocated by
Control. Its tenant D1 registry initially reported `schema_version=1` even though
the deployed databases were at core schema 51 and PII schema 12. A bounded,
tenant-scoped registry repair was applied, followed by the supported runtime
snapshot refresh. The resulting registry rows are `active`, the snapshot is
`snapshot_version=4`, and account provisioning operations complete successfully.
The temporary tenant-only `loadTest` rate-limit override was cleared after the
retry.

The RP-Initiated Logout retry used the same configuration as the July successful
run: `publish=everything`, `client_registration=static_client`, and
`client_secret_basic`. The Suite authorization, token, ID-token, and UserInfo
steps all passed, but Authrim returned HTTP 403 from the external callback before
the RP logout step. The bridge tail shows the failure occurs after UserInfo and
before the downstream handoff/logout redirect. The canonical runtime account and
subject are active in the tenant's users-core database; the callback's SSO session
lookup currently uses the metadata-core context, so it cannot find that
account-scoped runtime user. This is a deployed-code tenant-D1 separation issue,
not a static-vs-dynamic registration issue, rate limiting issue, TOTP issue, or
Suite publication issue.

Plans `xIZqYw3ikilJW` and `N4fLRiVJ6L25I` are diagnostic failures only and must not
be treated as certification evidence. Back-Channel Logout was not rerun after
this boundary was confirmed, because it depends on the same successful local
session handoff. No logout profile is currently claimable from the 2026-08-19
reruns.

### 13.1 2026-08-19 binding refresh and Suite-state finding

The missing snapshot was repaired by restoring valid Control-derived route
metadata for the three registry rows of the fresh tenant. The first repair used
shell-escaped JSON and was invalid; it was immediately replaced with SQLite
`json_object()` output and verified with `json_valid(metadata_json)=1`. The next
scheduled refresh published `snapshot_version=4` with a new 30-minute expiry and
`published=1, failed=0`.

After that repair, the generated D1 bindings were projected from Control into the
conformance lock and the following Workers were redeployed with the fresh tenant
bindings: ar-management, ar-auth, ar-token, ar-userinfo, ar-discovery, and
ar-bridge. The ar-bridge deployment also contains the account-scoped callback
context fix described above.

The next RP-Initiated Logout attempt reached Suite authorization, token, ID-token,
and UserInfo successfully. It then stopped in the Suite's primary
`oidcc-client-test-rp-init-logout` module on a second token request with
`ExtractClientCredentialsFromBasicAuthorizationHeader: Found existing client
authentication`. This is distinct from the earlier Authrim callback 403. The
July submitted PASS used `oidcc-client-test-rp-init-logout-other-state`; future
retries should select that module explicitly and retain `publish=everything`,
`static_client`, and `client_secret_basic`.

The first retry of `other-state` (result `2026-08-19_190521_222`) reproduced the
same Suite error. Comparing its log with the July PASS showed two authorization
and token cycles in the retry, while July had one. The browser navigation had
timed out at the client wrapper's 10-second CDP limit and was then issued a
second time; the first navigation was still in progress. The second cycle was
therefore a duplicated Suite flow, not an Authrim protocol failure. The next
attempt must issue the Suite `startUrl` exactly once, tolerate the wrapper timeout,
and continue with tenant selection without retrying the URL.

## Evidence status

### 2026-08-20 Back-Channel Logout retry notes

The target tenant initially had no published `login` Flow or `flow_assignments`,
which caused the TOTP controls to be absent. A standard login Flow with TOTP,
session-check, and OIDC completion nodes was restored through the admin Flow API,
published, and assigned at tenant scope. This was a test-environment repair and
must be included in the conformance environment change record.

The browser runner now resolves the discovery grant on the root discovery origin
before navigating to the target tenant. It also records fast completion-page
redirects and preserves cookies by host. Logout profiles must issue exactly one
RP-Initiated Logout request: Back-Channel Logout is driven by the runner's
cookie-aware HTTP logout step, while RP-Initiated Logout uses the browser logout
step. Calling both produces duplicate logout requests and can turn valid
negative Back-Channel Logout checks into Suite state-transition errors.

The stable first Back-Channel module reached OIDC authorization, token, UserInfo,
RP-Initiated Logout, and the Suite back-channel callback successfully. The later
retry runs must not be submitted when their `summary.json` contains `FAILED`,
`INTERRUPTED`, or a timeout. The final eight-module run below is the only
claimable Back-Channel result.

- Every completed RP result contains Suite logs, `summary.json`, and `report.md`.
- On 2026-08-19, the eight completed RP evidence packages were audited locally:
  100 client log files matched the `manifest.json` artifact list exactly, every
  filename began with the exact OIDF test name, and the repository's secret/JWT
  scanner passed for every log and manifest. The packages are the `client-data/`
  directories for Basic (13), Config (5), Dynamic (11), Form Post Basic (13),
  FAPI 2 RP OIDC (22), FAPI 2 RP plain OAuth (10), Message Signing JAR (10),
  and Message Signing JARM (16).
- No client-data package was generated for a failed or `INTERRUPTED` Logout run.
  The clean 2026-08-21 RP-Initiated and Back-Channel plans are complete, and both
  client-data packages were exported and audited using the same exact-name,
  manifest, and secret-scan checks.
- Placeholder checks for Basic, Config, Dynamic, Form Post, FAPI 2 RP OIDC, FAPI 2
  RP plain OAuth, JAR, and JARM reported that no test required image uploads. No
  image was fabricated or uploaded where the Suite had no image placeholder.
- Basic RP diagnostic evidence was exported successfully for 13 logs. Form Post
  Basic RP diagnostic evidence was exported successfully for 13 logs. Dynamic RP
  diagnostic evidence was exported successfully for 11 logs, including secret-free
  Suite-side trace records for WebFinger and Dynamic Registration. FAPI 2 Message
  Signing JARM evidence was exported successfully for all 16 logs. Config RP export
  stopped at signing-key rotation because the required diagnostic detail
  (`jwks_refreshed`) was absent. FAPI 2 RP
  OIDC/plain OAuth and Message Signing JAR exports stopped at the issuer-mismatch
  diagnostic assertion because Authrim recorded `authorization_request_failed`
  while the exporter expected `discovery_validation_failed`; the Suite logs remain
  complete and authoritative for those passed modules.

### 2026-08-20 Back-Channel final evidence and root cause (historical)

The historical `publish=everything` plan `4tWS0X9CzaFfy` completed all eight
Back-Channel Logout RP modules with `8 passed / 0 failed / 0 review / 0 warning /
0 skipped`. The claimable result is:

`private/conformance/OIDC RP Back-Channel Logout Basic/results/2026-08-20_034605_644/`

Its `client-data/` contains one exact-name diagnostic log for each module,
including the required negative-behavior markers (`unexpected_signing_algorithm`,
`missing_logout_event`, `audience_mismatch`, and `issuer_mismatch`) and the
positive processing marker. `manifest.json` and the artifact list were generated
from the final `summary.json`; no secrets, cookies, authorization headers, or
full JWTs are included.

The July/static-client execution model was retained: `static_client`,
`private_key_jwt`, TOTP browser login, and one cookie-aware logout request per
module. This run did not use DCR. The old attempts that navigated to the tenant
root and received logout 401s, or that were interrupted/timeouts, are diagnostic
only and must not be submitted.

The repeated provisioning failure was not a protocol failure. Authrim's
canonical identity graph batch had committed successfully, but the management
worker treated D1 batch results with `rowsAffected === 0` as failure. That left
account-creation operations in `writing`/`prepared` states and caused the Suite
flow to time out. The success criterion now uses batch result `success` and
statement-count consistency; safe stage diagnostics were added around the
canonical graph, PII/profile, authoritative directory, and outbox transitions.
After rebuild/deploy, a fresh module passed and the full eight-module plan passed.

The stale prepared/writing rows from earlier failed attempts remain test artifacts
and are excluded from the evidence package. They were not deleted because broad
cleanup would be destructive and is not needed to certify the final run.

This historical plan is superseded for submission by the clean 2026-08-21
Back-Channel plan `YGlyYLvn5dSrZ`, which has its own matching Suite logs and
sanitized `client-data` package.

## Cleanup status

The temporary rate-limit overrides on `default`, `oidc-basic-rp`, `fapi-ciba`, and
`fapi2` were cleared. The Control daily D1 budget was restored to `20` (with
`max_d1_resources` unchanged at `1000`). The FAPI 2, FAPI-CIBA, and Client
Credentials temporary TOTP users and preparation state were cleaned up, except
for the temporary TOTP state retained for the still-pending OP rerun, and the
temporary initial-access token and persisted FAPI RP key material were removed.
The earlier RP Logout temporary user was also cleaned up; the fresh diagnostic
tenant user remains until the OP/logout investigation is explicitly closed. The shared setup key was
recreated after the cleanup helper removed it, and a short-lived `admin:*` token was
verified without exposing its value. The default-tenant credential file was removed;
its user was not deleted because that file did not contain a stable user ID for a
safe targeted deletion.

Do not delete the blocked `fapi2-ms-final-rp-jarm` tenant without a separate
destructive-action confirmation.

## Evidence and privacy

- Suite logs and diagnostic exports can contain identifiers and protocol payloads.
- Keep generated results under the ignored `private/conformance/` tree.
- Do not print or commit Suite tokens, admin tokens, private keys, client secrets,
  TOTP secrets, or full JWTs.
- Redact cookies, authorization headers, tokens, and user PII before sharing evidence.
