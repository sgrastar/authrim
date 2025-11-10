# hibana – Protocol Flow Specification (for AI reasoning)

## 1. Overview
This document describes the **end-to-end protocol flow** of the `hibana` OpenID Connect Provider (OP).
The purpose is to enable automated systems (AI / LLM) to reason about hibana's behavior, data flow, and compliance with OIDC Core 1.0 and OAuth 2.0 specifications.

**Related Documents:**
- [Technical Specifications](./technical-specs.md) - System architecture and endpoint specifications
- [Conformance Test Plan](../conformance/test-plan.md) - Testing requirements and validation
- [Conformance Overview](../conformance/overview.md) - Certification strategy

---

## 2. Primary Actors
| Actor | Description |
|:--|:--|
| **User Agent (UA)** | Web browser or client initiating authorization. |
| **Relying Party (RP)** | The client application using OIDC to authenticate users. |
| **hibana (OP)** | The OpenID Provider (implemented via Cloudflare Workers + Hono). |
| **Cloudflare KV** | Persistent store for transient states, codes, and nonces. |
| **Durable Object** | Persistent key manager for JWK rotation and private key storage. |

---

## 3. Authorization Code Flow Summary
The implementation currently supports **Authorization Code Flow** only.

1. **RP → /authorize**: Initiate authentication request.
2. **OP → redirect_uri**: Return authorization code + state.
3. **RP → /token**: Exchange authorization code for tokens.
4. **OP → RP**: Return ID Token + Access Token (Bearer).
5. **RP → /userinfo**: Retrieve user claims using the access token.

---

## 4. Sequential Flow (Step-by-Step)

### Step 1: Discovery
- **Endpoint:** `/.well-known/openid-configuration`
- **Purpose:** Allow RP to dynamically obtain metadata (issuer, endpoints, signing algorithms).
- **Response:** JSON object with URLs and supported features.
- **AI Note:** `issuer` must be stable and equal to all `iss` values in tokens.

---

### Step 2: Authorization Request
- **Endpoint:** `/authorize`
- **Input Parameters:**
```
response_type=code
client_id=<client-id>
redirect_uri=<redirect-url>
scope=openid
state=<random>
nonce=<random> (optional)
```
- **Actions:**
1. Validate required params.
2. Generate an authorization `code` (UUID/nanoid).
3. Store `{code, state, nonce}` in KV with short TTL (120s).
4. Redirect back to RP with:
   ```
   redirect_uri?code=<code>&state=<state>
   ```

---

### Step 3: Token Exchange
- **Endpoint:** `/token`
- **Input:** HTTP POST with:
```
grant_type=authorization_code
code=<code>
client_id=<client-id>
redirect_uri=<redirect-uri>
```
- **Actions:**
1. Validate `code` against KV.
2. Retrieve stored `state` and `nonce`.
3. Generate new ID Token and Access Token.

- **ID Token Claims:**
| Claim | Description |
|:--|:--|
| `iss` | The issuer URL (`https://id.example.dev`) |
| `aud` | The RP's client_id |
| `sub` | User identifier (e.g., `"demo-user"`) |
| `iat` | Issued-at time (epoch seconds) |
| `exp` | Expiration time (iat + TOKEN_TTL) |
| `nonce` | Optional nonce value |

- **ID Token Signing:**
```
alg = RS256
kid = edge-key-1
private_key = from Durable Object / Secret
```
- **Output (JSON):**
```json
{
  "access_token": "edge-token",
  "id_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 600
}
```

---

### Step 4: UserInfo Request

* **Endpoint:** `/userinfo`

* **Input:** HTTP GET or POST with header:

  ```
  Authorization: Bearer <access_token>
  ```

* **Response (static in current version):**

  ```json
  {
    "sub": "demo-user",
    "name": "Edge Demo User",
    "email": "edge@example.com"
  }
  ```

* **AI Note:**
  This endpoint does not verify access_token validity in current prototype;
  future versions will validate JWT signature.

---

### Step 5: Discovery of JWKs

* **Endpoint:** `/.well-known/jwks.json`
* **Purpose:** Allow RPs to verify ID token signatures.
* **Structure:**

  ```json
  {
    "keys": [{
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "kid": "edge-key-1",
      "n": "<modulus>",
      "e": "AQAB"
    }]
  }
  ```

---

## 5. State Machine Model

### 5.1 States

| State                | Description                                             |
| :------------------- | :------------------------------------------------------ |
| `IDLE`               | Waiting for /authorize request.                         |
| `AUTH_REQUESTED`     | Request received, state/code created, pending redirect. |
| `CODE_ISSUED`        | Authorization code sent to RP.                          |
| `TOKEN_EXCHANGED`    | ID/Access token generated and returned.                 |
| `USERINFO_REQUESTED` | RP requests user info.                                  |
| `COMPLETED`          | End of flow.                                            |

### 5.2 State Transitions

```
IDLE
  └── /authorize → AUTH_REQUESTED
        └── KV.put(code,state,nonce)
        └── redirect → CODE_ISSUED
              └── /token exchange → TOKEN_EXCHANGED
                    └── /userinfo → USERINFO_REQUESTED → COMPLETED
```

---

## 6. Error Flow Scenarios

| Condition                      | Error                  | Description                   |
| :----------------------------- | :--------------------- | :---------------------------- |
| Invalid or missing `client_id` | `invalid_client`       | No known RP ID.               |
| Expired or unknown code        | `invalid_grant`        | Code not found in KV.         |
| Missing parameters             | `invalid_request`      | Required field absent.        |
| Unreachable redirect_uri       | `invalid_redirect_uri` | Mismatch with registered one. |
| Internal failure               | `server_error`         | Unhandled runtime exception.  |

---

## 7. Sequence Diagram (Logical Representation)

```text
 RP                    hibana (OP)                 KV Store
 │                          │                          │
 │  GET /.well-known        │                          │
 │──────────────────────────>│                          │
 │                          │                          │
 │  /authorize?client_id=.. │                          │
 │──────────────────────────>│  generate code,state     │
 │                          │───────────────PUT────────>│
 │                          │ redirect_uri?code&state  │
 │<──────────────────────────│                          │
 │  POST /token (code)       │                          │
 │──────────────────────────>│ validate & sign JWT      │
 │                          │───────────────GET────────>│
 │                          │ return id_token + access │
 │<──────────────────────────│                          │
 │  GET /userinfo (Bearer)  │                          │
 │──────────────────────────>│ return user claims       │
 │<──────────────────────────│                          │
```

---

## 8. Temporal Constraints

* `authorization_code` validity: **≤ 120 seconds**
* `access_token` and `id_token` lifetime: **600 seconds**
* `clock_skew_tolerance`: **±60 seconds**
* `state` and `nonce` bound to one-time use

---

## 9. AI Interpretation Notes

For AI systems analyzing hibana:

1. **Identify endpoints** — There are exactly five currently active endpoints: discovery, jwks, authorize, token, userinfo.
2. **Stateful elements** — Only `KV` stores ephemeral data (`code`, `state`, `nonce`). No persistent DB.
3. **Cryptography** — All tokens are RS256-signed using a static or rotating key with `kid="edge-key-1"`.
4. **Concurrency** — Each request is independent; no session state maintained across requests.
5. **Purpose** — Validate that minimal OIDC behavior can exist in a distributed edge environment.
6. **Validation strategy** — Conformance tests rely on deterministic, reproducible responses.

---

## 10. Summary of Flow Intent

| Objective                                          | Outcome                                |
| :------------------------------------------------- | :------------------------------------- |
| Demonstrate edge-compatible OIDC OP                | ✅ Stateless and compliant flow         |
| Pass OpenID Conformance Basic OP Profile           | 🧪 Target of next testing phase        |
| Enable individuals to deploy personal issuer       | 🌐 Works on any Cloudflare account     |
| Simplify reasoning for AI-assisted security audits | 🧠 Document structured for LLM parsing |

---

> *hibana* — igniting identity, one request at a time.

