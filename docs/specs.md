# hibana – Technical Specification (for AI analysis)

## 1. Project Overview
**hibana** is a lightweight, standards-compliant **OpenID Connect Provider (OP)** implemented entirely on **Cloudflare Workers** using **Hono** as the routing framework.  
It demonstrates that an individual developer can deploy a fully functional, globally distributed OpenID Provider (OIDC OP) at the edge.

---

## 2. Primary Objectives
- Implement the OpenID Connect Core 1.0 and Discovery 1.0 specifications on a serverless edge platform.
- Minimize operational complexity (no servers, no external DB, fully stateless).
- Achieve **OpenID Certified™ Basic OP Profile** compliance.
- Provide a reference implementation for educational and lightweight enterprise use.

---

## 3. Core Architecture

### 3.1 System Components
| Component | Role | Cloudflare Service |
|:--|:--|:--|
| **Worker (Hono App)** | Handles HTTP routes, authorization, and token issuance. | Cloudflare Workers |
| **KV Storage** | Persists authorization codes, states, and nonces (TTL-based). | Cloudflare KV |
| **Durable Object** | Optionally stores and rotates signing keys (JWK). | Cloudflare Durable Objects |
| **Secrets** | Stores the RSA private key for signing ID tokens. | Cloudflare Worker Secrets |
| **Automatic TLS** | Ensures HTTPS for all endpoints. | Cloudflare Edge Network |

### 3.2 Logical Flow Diagram
```

User → /authorize → [hibana OP] → redirect_uri (with code)
↳ /token → returns { access_token, id_token }
↳ /userinfo → user claims (static or dynamic)

````

### 3.3 Deployment Characteristics
- Global edge execution (multi-region, low latency)
- No dedicated server or container
- Built-in TLS, DNS, CDN caching by Cloudflare

---

## 4. Specification Compliance Map

| Category | Specification | Compliance | Notes |
|:--|:--|:--|:--|
| **Core** | OpenID Connect Core 1.0 | ✅ Implemented (Authorization Code Flow) | Supports `code` response type only |
| **Discovery** | OpenID Connect Discovery 1.0 | ✅ Fully implemented | `/.well-known/openid-configuration` |
| **Registration** | Dynamic Client Registration 1.0 | ⚙️ Planned | `/register` endpoint |
| **Session** | Session Management 1.0 | ❌ Not implemented | No iframe or `check_session` |
| **JWT / JWK** | RFC 7517 / 7519 | ✅ Implemented via `jose` | RS256 signing, static JWKS |
| **OAuth 2.0** | RFC 6749 / 6750 | ✅ Implemented | Basic Authorization Code flow |

---

## 5. Endpoints and Behaviors

### 5.1 Discovery
**Path:** `/.well-known/openid-configuration`  
**Purpose:** Return OP metadata including issuer, endpoints, supported claims, and algorithms.

Example response:
```json
{
  "issuer": "https://id.example.dev",
  "authorization_endpoint": "https://id.example.dev/authorize",
  "token_endpoint": "https://id.example.dev/token",
  "userinfo_endpoint": "https://id.example.dev/userinfo",
  "jwks_uri": "https://id.example.dev/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
````

---

### 5.2 JWKS

**Path:** `/.well-known/jwks.json`
**Purpose:** Publish public keys used for ID token signature verification.
Stored in KV or as static constant.

Example:

```json
{
  "keys": [
    {
      "kty": "RSA",
      "alg": "RS256",
      "use": "sig",
      "kid": "edge-key-1",
      "n": "<base64url modulus>",
      "e": "AQAB"
    }
  ]
}
```

---

### 5.3 Authorization Endpoint

**Path:** `/authorize`
**Function:** Handles user authorization and issues a temporary code.

Behavior:

1. Validate `client_id`, `redirect_uri`, `response_type=code`.
2. Generate `state` and `code` (stored in KV with TTL=120s).
3. Redirect to `redirect_uri?code={code}&state={state}`.

---

### 5.4 Token Endpoint

**Path:** `/token`
**Function:** Exchange `code` for an `id_token` and `access_token`.

Steps:

1. Validate `grant_type=authorization_code`, `code`, and `client_id`.
2. Load stored state from KV.
3. Create JWT with claims:

   * `iss`, `aud`, `sub`, `iat`, `exp`
4. Sign using RS256 (JOSE).
5. Return JSON:

```json
{
  "access_token": "edge-token",
  "id_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 600
}
```

---

### 5.5 UserInfo Endpoint

**Path:** `/userinfo`
**Function:** Return user claims for authenticated requests.
Currently static for conformance testing.

Response:

```json
{
  "sub": "demo-user",
  "name": "Edge Demo User",
  "email": "edge@example.com"
}
```

---

### 5.6 Dynamic Client Registration (Planned)

**Path:** `/register`
**Function:** Accept POST with client metadata, return client_id and configuration.
Not yet implemented.

---

### 5.7 Session Management (Future)

**Path:** `/check_session_iframe`
**Function:** Manage session state monitoring between RP and OP.
Not yet implemented.

---

## 6. Token Structure

### 6.1 ID Token (JWT)

Header:

```json
{ "alg": "RS256", "typ": "JWT", "kid": "edge-key-1" }
```

Payload:

```json
{
  "iss": "https://id.example.dev",
  "aud": "my-client-id",
  "sub": "demo-user",
  "iat": 1731200000,
  "exp": 1731200600
}
```

---

## 7. Environment Configuration

| Variable        | Purpose                                | Example                                                         |
| :-------------- | :------------------------------------- | :-------------------------------------------------------------- |
| `PRIVATE_KEY`   | RSA private key in PEM format          | `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"` |
| `STATE_KV`      | Cloudflare KV namespace for code/state | `"state-kv-namespace-id"`                                       |
| `ISSUER_DOMAIN` | Issuer domain (for `iss`)              | `"id.example.dev"`                                              |
| `JWKS_KID`      | Key ID for JWKS                        | `"edge-key-1"`                                                  |
| `TOKEN_TTL`     | Token lifetime (seconds)               | `600`                                                           |

---

## 8. Conformance Plan

| Stage       | Goal                                       | Tool / Criteria                   |
| :---------- | :----------------------------------------- | :-------------------------------- |
| **Phase 1** | Core + Discovery validation                | OpenID Conformance Suite (Docker) |
| **Phase 2** | Token signature validation (JWS / JWK)     | JWT.io / Conformance suite        |
| **Phase 3** | OAuth 2.0 grant tests (Authorization Code) | Conformance suite                 |
| **Phase 4** | Dynamic Registration                       | Manual / optional                 |
| **Phase 5** | Public certification                       | Submit to OpenID Foundation       |

---

## 9. Security Considerations

* All communications over HTTPS (Cloudflare-managed TLS).
* All tokens signed with private key; public JWK exposed for verification.
* `state` and `nonce` validated per OIDC Core spec.
* Authorization codes stored with short TTL (120 seconds).
* Nonce replay protection via KV or in-memory ephemeral binding.
* CORS disabled by default.

---

## 10. Future Enhancements

* Rotating JWKS keys via Durable Object
* Nonce verification
* Form Post response mode
* Refresh Token support
* User authentication integration (passwordless / WebAuthn)

---

## 11. License

MIT License © 2025 [sgrastar](https://github.com/sgrastar)

---

## 12. Summary (AI context)

In short:

* **hibana** is a Cloudflare Workers-based implementation of an **OpenID Provider (OP)**.
* It adheres to **OIDC Core**, **Discovery**, and **OAuth 2.0** specifications.
* It’s **stateless**, **edge-native**, and suitable for **OpenID Conformance certification**.
* Its key innovation: *individual developers can deploy their own issuer on the edge.*

> Conceptually: “hibana ignites identity — a spark of trust at the edge.”

