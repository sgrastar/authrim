# Phase 9: Advanced Identity (VC/DID)

**Timeline:** 2026-Q3
**Status:** 🔜 Planned

---

## Overview

Phase 9 implements next-generation identity protocols including Verifiable Credentials (VC), Verifiable Presentations (VP), and Decentralized Identifiers (DID). Building on the SD-JWT foundation from Phase 6, this phase enables Authrim to issue and verify cryptographically-signed credentials that users can store in digital wallets.

---

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Digital Wallet (User-Controlled)                    │
│   • Mobile Wallet App    • Browser Extension    • Hardware Key          │
│   Stores: Verifiable Credentials, DIDs, Keys                            │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────────┐      ┌───────────────────┐      ┌───────────────────┐
│   OpenID4CI       │      │   OpenID4VP       │      │   DID Resolver    │
│   (Issuance)      │      │   (Presentation)  │      │                   │
│   Authrim as      │      │   Authrim as      │      │   • did:web       │
│   Credential      │      │   Verifier        │      │   • did:key       │
│   Issuer          │      │                   │      │                   │
└───────────────────┘      └───────────────────┘      └───────────────────┘
        │                             │                             │
        └─────────────────────────────┼─────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Identity Hub (Phase 7-8)                            │
│   • Unified Identity    • Policy Engine    • Token Issuance             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 9.1 OpenID4VP (Verifiable Presentations)

Implement OpenID for Verifiable Presentations (OID4VP) to receive and verify credentials:

### Specification Research 🔜

- [ ] Study OID4VP specification (OpenID Connect for Verifiable Presentations)
- [ ] Understand presentation definition format
- [ ] Review credential format requirements
- [ ] Document implementation decisions

### Presentation Definition 🔜

Define what credentials the verifier requests:

- [ ] Design presentation definition schema

  ```typescript
  interface PresentationDefinition {
    id: string;
    name: string;
    purpose: string;
    input_descriptors: InputDescriptor[];
  }

  interface InputDescriptor {
    id: string;
    name: string;
    purpose: string;
    format: {
      jwt_vc_json?: { alg: string[] };
      'vc+sd-jwt'?: { alg: string[] };
    };
    constraints: {
      fields: FieldConstraint[];
    };
  }
  ```

- [ ] Implement presentation definition builder
- [ ] Support multiple credential types
- [ ] Add field-level constraints
- [ ] Unit tests

### Authorization Request for VP 🔜

Create requests that trigger wallet presentation:

- [ ] Implement VP authorization request
  ```typescript
  // Request parameters
  {
    response_type: 'vp_token',
    presentation_definition: { ... },
    nonce: 'random-nonce',
    client_metadata: {
      vp_formats: {
        'vc+sd-jwt': { alg: ['ES256'] }
      }
    }
  }
  ```
- [ ] Support same-device and cross-device flows
- [ ] Generate QR codes for cross-device
- [ ] Handle redirect URIs
- [ ] Unit tests

### VP Token Validation 🔜

Verify received verifiable presentations:

- [ ] Implement VP Token parsing
- [ ] Verify presentation signature
- [ ] Validate credential signatures
- [ ] Check credential status (revocation)
- [ ] Extract claims from presentations
- [ ] Map VC claims to Authrim user attributes
- [ ] Unit tests (25+ tests)

### Credential Format Support 🔜

- [ ] JWT-VC (JSON Web Token Verifiable Credential)
- [ ] SD-JWT VC (Selective Disclosure - using Phase 6 SD-JWT)
- [ ] JSON-LD VC (optional, complex)

### Verifier UI 🔜

- [ ] Presentation request page
- [ ] QR code display for cross-device
- [ ] Credential verification status display
- [ ] Extracted claims preview
- [ ] Error handling UI

---

## 9.2 OpenID4CI (Credential Issuance)

Implement OpenID for Verifiable Credential Issuance (OID4CI):

### Specification Research 🔜

- [ ] Study OID4CI specification
- [ ] Understand credential offer format
- [ ] Review issuance flows (pre-authorized, authorization code)
- [ ] Document implementation decisions

### Credential Issuer Metadata 🔜

Publish issuer capabilities:

- [ ] Implement `/.well-known/openid-credential-issuer` endpoint
  ```typescript
  {
    credential_issuer: 'https://auth.example.com',
    authorization_servers: ['https://auth.example.com'],
    credential_endpoint: 'https://auth.example.com/credentials',
    credentials_supported: [
      {
        format: 'vc+sd-jwt',
        id: 'IdentityCredential',
        cryptographic_binding_methods_supported: ['did:key', 'jwk'],
        credential_signing_alg_values_supported: ['ES256'],
        claims: {
          given_name: { display: [{ name: 'Given Name' }] },
          family_name: { display: [{ name: 'Family Name' }] },
          email: { display: [{ name: 'Email' }] }
        }
      }
    ]
  }
  ```
- [ ] Support multiple credential types
- [ ] Add display metadata for wallets
- [ ] Unit tests

### Credential Offer 🔜

Generate offers that wallets can scan:

- [ ] Implement credential offer generation
  ```typescript
  interface CredentialOffer {
    credential_issuer: string;
    credential_configuration_ids: string[];
    grants?: {
      'urn:ietf:params:oauth:grant-type:pre-authorized_code'?: {
        'pre-authorized_code': string;
        user_pin_required: boolean;
      };
      authorization_code?: {
        issuer_state: string;
      };
    };
  }
  ```
- [ ] Generate credential offer URIs
- [ ] Create QR codes for offers
- [ ] Implement pre-authorized code flow
- [ ] Implement authorization code flow for issuance
- [ ] Unit tests

### Credential Endpoint 🔜

Issue credentials to authenticated users:

- [ ] Implement `POST /credentials` endpoint

  ```typescript
  // Request
  {
    format: 'vc+sd-jwt',
    credential_definition: {
      type: ['VerifiableCredential', 'IdentityCredential']
    },
    proof: {
      proof_type: 'jwt',
      jwt: 'eyJ...' // Holder binding proof
    }
  }

  // Response
  {
    credential: 'eyJ...~eyJ...~eyJ...', // SD-JWT VC
    c_nonce: 'new-nonce',
    c_nonce_expires_in: 300
  }
  ```

- [ ] Integrate with SD-JWT implementation (Phase 6)
- [ ] Validate holder binding proof
- [ ] Sign credentials with issuer key
- [ ] Support multiple credential types
- [ ] Unit tests (20+ tests)

### Credential Status 🔜

Support credential revocation/suspension:

- [ ] Design status list format (Bitstring Status List)
- [ ] Implement `/.well-known/vc-status` endpoint
- [ ] Create status update API
- [ ] Add revocation to credential claims
- [ ] Unit tests

### Issuer UI 🔜

- [ ] Credential types management page
- [ ] Issue credential wizard
- [ ] Credential status dashboard
- [ ] Revocation management
- [ ] Issuance audit log

---

## 9.3 DID Support

Implement Decentralized Identifier resolution:

### DID Core Understanding 🔜

- [ ] Study W3C DID Core specification
- [ ] Understand DID document structure
- [ ] Review verification method formats
- [ ] Document supported DID methods

### did:web Resolver 🔜

Resolve DIDs hosted on web servers:

- [ ] Implement `did:web` resolution

  ```typescript
  // did:web:example.com → https://example.com/.well-known/did.json
  // did:web:example.com:user:alice → https://example.com/user/alice/did.json

  interface DIDDocument {
    '@context': string[];
    id: string;
    verificationMethod: VerificationMethod[];
    authentication?: string[];
    assertionMethod?: string[];
  }
  ```

- [ ] Fetch and parse DID documents
- [ ] Validate document structure
- [ ] Cache resolved documents (KV)
- [ ] Handle resolution errors
- [ ] Unit tests

### did:key Resolver 🔜

Resolve self-certifying DIDs from public keys:

- [ ] Implement `did:key` resolution

  ```typescript
  // did:key:z6Mk... → Derive DID document from multibase key

  // Example DID document
  {
    '@context': [...],
    id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    verificationMethod: [{
      id: 'did:key:z6Mk...#z6Mk...',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:key:z6Mk...',
      publicKeyMultibase: 'z6Mk...'
    }],
    authentication: ['did:key:z6Mk...#z6Mk...'],
    assertionMethod: ['did:key:z6Mk...#z6Mk...']
  }
  ```

- [ ] Parse multibase-encoded public keys
- [ ] Support Ed25519 keys
- [ ] Support P-256 (secp256r1) keys
- [ ] Support secp256k1 keys
- [ ] Generate DID documents from keys
- [ ] Unit tests

### DID Document Generation 🔜

Generate and host Authrim's own DID:

- [ ] Generate Authrim issuer DID
- [ ] Host DID document at `/.well-known/did.json`
- [ ] Include signing keys from KeyManager
- [ ] Auto-update on key rotation
- [ ] Unit tests

### DID Authentication 🔜

Support DID-based authentication:

- [ ] Design DID authentication flow
  ```
  1. User presents DID
  2. Resolve DID document
  3. Challenge user to sign with verification method
  4. Verify signature
  5. Link DID to Authrim identity
  ```
- [ ] Implement challenge generation
- [ ] Implement signature verification
- [ ] Add DID as identity linking option
- [ ] Integration tests

### VP/VC Integration 🔜

- [ ] Use DIDs in credential issuance (issuer DID)
- [ ] Verify holder DIDs in presentations
- [ ] Resolve subject DIDs in credentials
- [ ] Cache DID resolution results

---

## Database Migrations

### Migration 024: Credential Types

- [ ] Create `credential_types` table
- [ ] Create `issued_credentials` table
- [ ] Create `credential_status` table

### Migration 025: DID Registry

- [ ] Create `did_documents` table (cached resolutions)
- [ ] Create `user_dids` table (linked DIDs per user)

---

## Testing Requirements

### Unit Tests

- [ ] OpenID4VP tests (30+ tests)
- [ ] OpenID4CI tests (30+ tests)
- [ ] DID resolver tests (20+ tests)
- [ ] SD-JWT VC tests (extend from Phase 6)

### Integration Tests

- [ ] Full credential issuance flow
- [ ] Full presentation verification flow
- [ ] DID-based authentication flow
- [ ] Cross-wallet compatibility

### Compatibility Tests

- [ ] Test with common wallets:
  - [ ] Sphereon Wallet
  - [ ] Veramo
  - [ ] Walt.id
  - [ ] MATTR wallet

---

## Success Metrics

| Metric               | Target | Current |
| -------------------- | ------ | ------- |
| OID4VP tests         | 30+    | -       |
| OID4CI tests         | 30+    | -       |
| DID tests            | 20+    | -       |
| Credential types     | 3+     | -       |
| Wallet compatibility | 3+     | -       |

---

## Dependencies

- Phase 6: SD-JWT ✅
- Phase 7: Identity Hub
- Phase 8: Unified Policy
- jose library ✅
- KeyManager Durable Object ✅

---

## Related Documents

- [ROADMAP](../ROADMAP.md) - Overall product direction
- [SD-JWT Implementation](../features/sd-jwt.md)
- [TASKS_Phase8.md](./TASKS_Phase8.md) - Previous phase (Unified Policy)
- [TASKS_Phase10.md](./TASKS_Phase10.md) - Next phase (SDK & API)

---

## Specification References

- [OpenID4VP](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)
- [OpenID4CI](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html)
- [DID Core](https://www.w3.org/TR/did-core/)
- [SD-JWT VC](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-sd-jwt-vc)
- [Bitstring Status List](https://w3c-ccg.github.io/vc-status-list-2021/)

---

> **Last Update**: 2025-12-03 (Phase 9 definition for Advanced Identity)
