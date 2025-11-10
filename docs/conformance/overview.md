# hibana – Conformance Overview

## 1. Vision
**hibana** is a lightweight, edge-native OpenID Connect Provider designed to show that  
a single developer can operate a fully compliant identity provider — safely, globally, and at minimal cost.

Its conformance goal is not only certification, but **to redefine what “compliant infrastructure” means in the era of serverless computing.**

---

## 2. Conformance Strategy (High-Level)

| Stage | Objective | Focus |
|:--|:--|:--|
| **Phase 1 – Baseline** | Build a fully working Authorization Code Flow OP. | Implement Core + Discovery + OAuth 2.0 essentials. |
| **Phase 2 – Validation** | Pass OpenID Foundation Conformance Suite (Basic OP). | Token / claims / state correctness. |
| **Phase 3 – Expansion** | Add Dynamic Registration and Session Management. | Broaden spec coverage and interoperability. |
| **Phase 4 – Certification** | Obtain OpenID Certified™ mark. | Submit formal results to OIDF. |
| **Phase 5 – Research** | Explore Edge-native extensions. | Dynamic key rotation, DPoP, Privacy Pass, WebAuthn integration. |

---

## 3. Current Compliance Level (Summary)

| Area | Status | Description |
|:--|:--|:--|
| **Core 1.0** | ✅ Implemented | Authorization Code Flow, ID Token (RS256), error handling, nonce/state management. |
| **Discovery 1.0** | ✅ Implemented | Metadata endpoint and issuer consistency. |
| **OAuth 2.0** | ✅ Implemented | RFC 6749 / 6750 compatible, Bearer token flow. |
| **JWT / JWK** | ✅ Implemented | RFC 7517 / 7519, RS256 with fixed key ID. |
| **Dynamic Registration** | ⚙️ Planned | `/register` endpoint (Phase 3). |
| **Session Management** | ❌ Not implemented | Will be explored in Phase 3+. |

---

## 4. Design Principles

| Principle | Description |
|:--|:--|
| **Edge-Native Compliance** | Run all OIDC flows on Cloudflare Workers with no dedicated server. |
| **Minimal Statefulness** | Use KV for transient state only (codes, nonces). |
| **Transparent Cryptography** | Sign and publish JWKs openly for verification. |
| **Human + AI Auditable** | All flows documented for both human and AI analysis. |
| **Self-Contained Certification** | Enable “solo developers” to achieve official certification. |

---

## 5. Certification Roadmap

| Milestone | Deliverable | Timeline |
|:--|:--|:--|
| ✅ M1 | Core endpoints + Discovery operational | Complete |
| 🧪 M2 | Local conformance suite tests passing | In progress |
| ⚙️ M3 | Add Dynamic Client Registration | Planned |
| ⚙️ M4 | Session Management iframe support | Planned |
| 🏁 M5 | Submit to OIDF for Basic OP certification | Target Q2 2026 |

---

## 6. OpenID Foundation Scope Declaration (Planned)

| Attribute | Value |
|:--|:--|
| **Issuer (iss)** | `https://id.hibana.dev` |
| **Profile** | Basic OpenID Provider |
| **Conformance Suite** | `https://openid.net/certification/` |
| **Deployment Type** | Cloudflare Workers |
| **Language / Framework** | TypeScript + Hono |
| **Key Management** | RS256 (Durable Object, static kid=`edge-key-1`) |

---

## 7. AI Compliance Meta-Goals

1. **Machine-Verifiable Specs** – All endpoints and flows are described in AI-parsable form (`docs/spec.md`, `docs/flow.md`).
2. **Self-Assessment** – AI agents can calculate compliance score via `tests/conformance-plan.md`.
3. **Auto-Documentation** – Future agents can extract these markdown files to generate certification forms.
4. **Explainable Conformance** – Each requirement maps to a documented reason for inclusion/exclusion.

---

## 8. Long-Term Vision
hibana aims to become the **reference “Edge OP”**:
- Zero infrastructure overhead.
- Zero database dependencies.
- Fully explainable OIDC compliance.
- Open source, auditable, and reproducible.

If a solo developer can deploy and certify a global identity service,  
then compliance itself becomes democratized — not just centralized.

---

> *hibana* — compliance as creation, not constraint.
