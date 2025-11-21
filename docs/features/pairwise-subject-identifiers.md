# Pairwise Subject Identifiers

## Overview

**OpenID Connect Core 1.0 Section 8** - Subject Identifier Types

Authrim implements pairwise subject identifiers, a privacy-enhancing feature that provides different subject (`sub`) values for the same user across different clients, preventing user tracking and correlation across applications.

## Specification

- **Specification**: [OpenID Connect Core 1.0 Section 8](https://openid.net/specs/openid-connect-core-1_0.html#SubjectIDTypes)
- **Algorithm**: [OIDC Core 8.1 - Pairwise Identifier Algorithm](https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg)
- **Status**: ✅ Implemented
- **Configuration**: Client registration (`subject_type` parameter)

---

## Why Use Pairwise Subject Identifiers?

### Privacy Benefits

1. **🔒 User Privacy Protection**
   - Different `sub` values for same user across clients
   - Prevents user tracking across applications
   - Complies with privacy regulations (GDPR, CCPA)
   - Reduces data correlation risks

2. **🛡️ Prevents Client Collusion**
   - Clients cannot correlate users by comparing `sub` values
   - Each client sees unique identifier for each user
   - Protects against malicious client cooperation
   - Enforces data minimization principles

3. **📊 Data Protection Compliance**
   - **GDPR Article 25**: Privacy by Design
   - **GDPR Article 32**: Pseudonymization
   - **CCPA**: Consumer privacy protection
   - **HIPAA**: Healthcare data protection

4. **✅ Security Benefits**
   - Limits blast radius of data breaches
   - Reduces identity correlation attacks
   - Protects user identity across services
   - Supports zero-trust architecture

### Use Cases

- **Healthcare**: HIPAA-compliant patient identifiers
- **Finance**: GDPR-compliant banking applications
- **Government**: Citizen privacy protection
- **Enterprise**: Employee privacy across departments
- **Consumer Apps**: User privacy across third-party integrations
- **Multi-Tenant SaaS**: Tenant isolation and privacy

---

## How Pairwise Subject Identifiers Work

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│    A     │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. Client Registration                         │
      │    (subject_type: "pairwise")                  │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │ 2. User Authorization                          │
      │    User ID: "user-12345"                       │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 3. Generate
      │                                                 │    Pairwise Sub
      │                                                 │    SHA-256(
      │                                                 │      sector +
      │                                                 │      user_id +
      │                                                 │      salt
      │                                                 │    )
      │                                                 │    = "AbC123..."
      │                                                 │
      │ 4. ID Token                                    │
      │    sub: "AbC123..."                            │
      │<────────────────────────────────────────────────┤
      │                                                 │


┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│    B     │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. Client Registration                         │
      │    (subject_type: "pairwise")                  │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │ 2. Same User Authorization                     │
      │    User ID: "user-12345" (same user!)          │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 3. Generate
      │                                                 │    Different
      │                                                 │    Pairwise Sub
      │                                                 │    (different
      │                                                 │     sector)
      │                                                 │    = "XyZ789..."
      │                                                 │
      │ 4. ID Token                                    │
      │    sub: "XyZ789..." (different!)               │
      │<────────────────────────────────────────────────┤
      │                                                 │
```

**Result**: Same user, different clients → Different `sub` values

### Pairwise Algorithm (OIDC Core 8.1)

```
sub = base64url(SHA-256(sector_identifier || local_account_id || salt))
```

**Components**:
- `sector_identifier`: Client's host (e.g., `example.com`)
- `local_account_id`: User's internal ID (e.g., `user-12345`)
- `salt`: Server secret for additional security
- `||`: Concatenation operator

---

## Subject Type Comparison

### Public Subject Type (Default)

```json
{
  "sub": "user-12345",
  "iss": "https://authrim.sgrastar.workers.dev",
  "aud": "client_abc",
  ...
}
```

**Characteristics**:
- ✅ Same `sub` value across all clients
- ✅ Simpler implementation
- ❌ Clients can correlate users
- ❌ Privacy risks
- **Use Case**: Internal applications, trusted clients

### Pairwise Subject Type

**Client A**:
```json
{
  "sub": "AbC123XyZ456...",
  "iss": "https://authrim.sgrastar.workers.dev",
  "aud": "client_a",
  ...
}
```

**Client B** (same user):
```json
{
  "sub": "PqR789StU012...",
  "iss": "https://authrim.sgrastar.workers.dev",
  "aud": "client_b",
  ...
}
```

**Characteristics**:
- ✅ Different `sub` values per client
- ✅ Enhanced privacy
- ✅ GDPR/CCPA compliant
- ✅ Prevents user correlation
- **Use Case**: Third-party integrations, public APIs, high-security environments

---

## API Reference

### Client Registration with Pairwise

**POST /register**

#### Request

```json
{
  "redirect_uris": ["https://app.example.com/callback"],
  "client_name": "My Privacy-Focused App",
  "subject_type": "pairwise"
}
```

**Parameters**:

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `subject_type` | ❌ No | string | Subject identifier type: `public` (default) or `pairwise` |
| `sector_identifier_uri` | ❌ Conditional | string | HTTPS URI for sector identifier (required if multiple redirect URIs have different hosts) |

#### Response

```json
{
  "client_id": "client_AbC123...",
  "client_secret": "XyZ456...",
  "redirect_uris": ["https://app.example.com/callback"],
  "subject_type": "pairwise",
  ...
}
```

---

### Pairwise with Multiple Redirect URIs

#### Same Host (No sector_identifier_uri required)

```json
{
  "redirect_uris": [
    "https://app.example.com/callback1",
    "https://app.example.com/callback2"
  ],
  "subject_type": "pairwise"
}
```

✅ **Valid**: All redirect URIs have same host (`app.example.com`)

#### Different Hosts (sector_identifier_uri required)

```json
{
  "redirect_uris": [
    "https://app1.example.com/callback",
    "https://app2.example.com/callback"
  ],
  "subject_type": "pairwise",
  "sector_identifier_uri": "https://example.com/.well-known/sector-uris.json"
}
```

✅ **Valid**: Different hosts, but `sector_identifier_uri` provided

**sector-uris.json** (example):
```json
[
  "https://app1.example.com/callback",
  "https://app2.example.com/callback"
]
```

#### Different Hosts (No sector_identifier_uri)

```json
{
  "redirect_uris": [
    "https://app1.example.com/callback",
    "https://app2.example.com/callback"
  ],
  "subject_type": "pairwise"
}
```

❌ **Invalid**: Returns `invalid_client_metadata` error

---

## Implementation Details

### Pairwise Subject Generation

```typescript
async function generatePairwiseSubject(
  localAccountId: string,
  sectorIdentifier: string,
  salt: string
): Promise<string> {
  // OIDC Core 8.1: sub = SHA-256(sector || local_account_id || salt)
  const data = `${sectorIdentifier}${localAccountId}${salt}`;

  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // Hash with SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode(...hashArray));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

### Sector Identifier Extraction

```typescript
function extractSectorIdentifier(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.host; // Returns hostname:port
}
```

**Examples**:
- `https://example.com/callback` → `example.com`
- `https://example.com:8080/callback` → `example.com:8080`
- `http://localhost:3000/callback` → `localhost:3000`

### Effective Sector Identifier

```typescript
function determineEffectiveSectorIdentifier(
  redirectUris: string[],
  sectorIdentifierUri?: string
): string {
  // If sector_identifier_uri provided, use its host
  if (sectorIdentifierUri) {
    return extractSectorIdentifier(sectorIdentifierUri);
  }

  // Otherwise, use host from first redirect_uri
  return extractSectorIdentifier(redirectUris[0]);
}
```

### Subject Identifier Generation

```typescript
async function generateSubjectIdentifier(
  localAccountId: string,
  subjectType: 'public' | 'pairwise',
  sectorIdentifier?: string,
  salt?: string
): Promise<string> {
  if (subjectType === 'public') {
    // Public: return local account ID directly
    return localAccountId;
  }

  // Pairwise: generate cryptographic hash
  if (!sectorIdentifier || !salt) {
    throw new Error('Sector identifier and salt required for pairwise');
  }

  return await generatePairwiseSubject(localAccountId, sectorIdentifier, salt);
}
```

---

## Usage Examples

### Example 1: Register Client with Pairwise

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://myapp.example.com/callback"],
    "client_name": "Privacy-Focused App",
    "subject_type": "pairwise"
  }'
```

**Response**:
```json
{
  "client_id": "client_AbC123...",
  "client_secret": "XyZ456...",
  "redirect_uris": ["https://myapp.example.com/callback"],
  "subject_type": "pairwise",
  ...
}
```

---

### Example 2: Multiple Redirect URIs (Same Host)

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": [
      "https://myapp.example.com/callback1",
      "https://myapp.example.com/callback2"
    ],
    "subject_type": "pairwise"
  }'
```

✅ **Works**: All URIs have same host

---

### Example 3: Multiple Redirect URIs (Different Hosts)

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": [
      "https://app1.example.com/callback",
      "https://app2.example.com/callback"
    ],
    "subject_type": "pairwise",
    "sector_identifier_uri": "https://example.com/.well-known/sector-uris.json"
  }'
```

✅ **Works**: `sector_identifier_uri` provided

---

### Example 4: Comparing Public vs Pairwise

**Register Two Clients** (same user authorizes both):

**Client A (Public)**:
```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://app-a.example.com/callback"],
    "subject_type": "public"
  }'
```

**Client B (Public)**:
```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://app-b.example.com/callback"],
    "subject_type": "public"
  }'
```

**Result**:
- Client A gets: `sub: "user-12345"`
- Client B gets: `sub: "user-12345"` ← **Same!**
- ❌ Clients can correlate users

**Client C (Pairwise)**:
```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://app-c.example.com/callback"],
    "subject_type": "pairwise"
  }'
```

**Client D (Pairwise)**:
```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://app-d.example.com/callback"],
    "subject_type": "pairwise"
  }'
```

**Result**:
- Client C gets: `sub: "AbC123XyZ456..."`
- Client D gets: `sub: "PqR789StU012..."` ← **Different!**
- ✅ Clients cannot correlate users

---

## Security Considerations

### 1. Salt Management

**Salt Requirements**:
- ✅ **Cryptographically Secure**: Use strong random salt
- ✅ **Server Secret**: Never expose salt to clients
- ✅ **Consistent**: Same salt for all pairwise subjects
- ✅ **Rotatable**: Support salt rotation with grace period

**Example**:
```env
PAIRWISE_SALT="your-cryptographically-secure-secret-salt-here"
```

### 2. Sector Identifier Validation

**Validation Rules**:
- ✅ **HTTPS Required**: `sector_identifier_uri` must use HTTPS
- ✅ **Host Consistency**: All redirect URIs must match sector identifier
- ✅ **JSON Array**: Sector identifier URI must return JSON array of URIs
- ✅ **URI Matching**: All redirect URIs must be in sector identifier list

### 3. Privacy Protection

**Best Practices**:
- ✅ Use pairwise for third-party clients
- ✅ Use public for first-party/internal clients
- ✅ Document privacy policy clearly
- ✅ Allow users to view connected clients

### 4. Storage Considerations

**Pairwise Mapping Storage**:
- Store mapping: `(user_id, sector_identifier) → pairwise_sub`
- Enable reverse lookup for account management
- Support data portability requirements
- Implement secure deletion for GDPR compliance

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PAIRWISE_SALT` | Required | Secret salt for pairwise subject generation |

**Example Configuration**:
```toml
# wrangler.toml
[vars]
# Public variables
ISSUER_URL = "https://authrim.sgrastar.workers.dev"

# Secrets (set via `wrangler secret put`)
# PAIRWISE_SALT = "<your-secret-salt>"
```

**Set Salt Secret**:
```bash
wrangler secret put PAIRWISE_SALT
# Enter value: <paste-your-cryptographically-secure-salt>
```

### Discovery Metadata

Subject type support is advertised in OpenID Provider metadata:

```json
{
  "subject_types_supported": ["public", "pairwise"]
}
```

---

## Testing

### Test Coverage

Authrim includes comprehensive tests for pairwise subject identifiers:

**Test File**: `test/pairwise.test.ts`

**Test Scenarios**:
- ✅ Pairwise subject generation (base64url encoding)
- ✅ Consistent subjects for same inputs
- ✅ Different subjects for different sector identifiers
- ✅ Different subjects for different users
- ✅ Different subjects with different salts
- ✅ Sector identifier extraction (host + port)
- ✅ Sector identifier validation (localhost)
- ✅ Invalid URL handling
- ✅ Query parameter handling
- ✅ Sector identifier consistency validation (single URI)
- ✅ Sector identifier consistency validation (multiple URIs, same host)
- ✅ Sector identifier consistency validation (multiple URIs, different hosts)
- ✅ Empty redirect URIs handling
- ✅ Effective sector identifier determination
- ✅ Effective sector identifier with sector_identifier_uri
- ✅ Subject identifier generation (public type)
- ✅ Subject identifier generation (pairwise type)
- ✅ Error handling (missing sector identifier or salt)

**Total**: 22+ test cases

### Running Tests

```bash
npm test -- pairwise.test.ts
```

---

## Troubleshooting

### Common Issues

#### "sector_identifier_uri is required when using pairwise subject type with multiple redirect URIs from different hosts"

**Cause**: Multiple redirect URIs with different hosts, but no `sector_identifier_uri`

**Solution**:
```json
{
  "redirect_uris": [
    "https://app1.example.com/callback",
    "https://app2.example.com/callback"
  ],
  "subject_type": "pairwise",
  "sector_identifier_uri": "https://example.com/.well-known/sector-uris.json"
}
```

#### "Sector identifier is required for pairwise subject type"

**Cause**: Attempting to generate pairwise subject without sector identifier

**Solution**: Ensure client has valid redirect URIs or sector_identifier_uri

#### "Salt is required for pairwise subject type"

**Cause**: Server not configured with pairwise salt

**Solution**: Set `PAIRWISE_SALT` environment variable/secret

```bash
wrangler secret put PAIRWISE_SALT
```

#### Inconsistent `sub` values for same user

**Cause**: Salt changed between token issuances

**Solution**: Keep salt consistent. For salt rotation:
1. Store old salt alongside new salt
2. Try both salts when validating existing tokens
3. Remove old salt after grace period

---

## Best Practices

### When to Use Pairwise

**✅ Use Pairwise For:**
- Third-party integrations
- Public APIs
- Healthcare applications (HIPAA)
- Financial services (GDPR)
- Government services
- Consumer-facing applications
- Multi-tenant SaaS platforms

**❌ Use Public For:**
- First-party applications
- Internal enterprise tools
- Single-organization deployments
- Development/testing environments
- Applications requiring user correlation

### Privacy Policy

**Recommendations**:
1. **Disclose Subject Type**: Inform users about privacy protection
2. **Data Minimization**: Only request necessary scopes
3. **User Consent**: Clear consent for data sharing
4. **Access Control**: Allow users to view/revoke client access

### Account Management

**Implementation Tips**:
1. **Store Mappings**: Keep `(user_id, client_id) → pairwise_sub` mapping
2. **Reverse Lookup**: Support finding all clients for a user
3. **Data Portability**: Export user's connected clients
4. **Right to Erasure**: Delete all pairwise mappings on account deletion

### Salt Rotation

**Strategy**:
1. Generate new salt
2. Store both old and new salts
3. Use new salt for new tokens
4. Support both salts for validation (grace period: 30-90 days)
5. Remove old salt after grace period
6. Notify clients about salt rotation

---

## Compliance

### GDPR (General Data Protection Regulation)

**Relevant Articles**:
- **Article 25**: Privacy by Design and by Default
  - ✅ Pairwise implements privacy by design
- **Article 32**: Security of Processing
  - ✅ Pseudonymization through pairwise subjects
- **Article 17**: Right to Erasure
  - ✅ Delete pairwise mappings on user request

### CCPA (California Consumer Privacy Act)

**Requirements**:
- **Do Not Sell**: Pairwise prevents unauthorized user tracking
- **Right to Know**: Users can see connected clients
- **Right to Delete**: Delete all pairwise mappings

### HIPAA (Health Insurance Portability and Accountability Act)

**Requirements**:
- **De-identification**: Pairwise provides de-identification across clients
- **Minimum Necessary**: Limits data exposure
- **Access Controls**: Different identifiers per client

---

## Future Enhancements

### Planned Features (Phase 5+)

- [ ] **Dynamic Salt Rotation**: API for rotating pairwise salt
- [ ] **Pairwise Mapping API**: Endpoint for listing user's pairwise subjects
- [ ] **Account Linking**: Link pairwise subjects across sectors
- [ ] **Sector Identifier URI Validation**: Fetch and validate sector identifier URI
- [ ] **Admin Dashboard**: View pairwise mappings per user
- [ ] **Audit Log**: Track pairwise subject generation and usage
- [ ] **Migration Tool**: Convert existing public subjects to pairwise

---

## References

- [OpenID Connect Core 1.0 - Section 8: Subject Identifier Types](https://openid.net/specs/openid-connect-core-1_0.html#SubjectIDTypes)
- [OpenID Connect Core 1.0 - Section 8.1: Pairwise Identifier Algorithm](https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg)
- [GDPR Article 25 - Privacy by Design](https://gdpr-info.eu/art-25-gdpr/)
- [GDPR Article 32 - Security of Processing](https://gdpr-info.eu/art-32-gdpr/)
- [RFC 7519 - JSON Web Token (JWT)](https://tools.ietf.org/html/rfc7519)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 22+ passing tests
**Implementation**: `src/utils/pairwise.ts`, `src/handlers/register.ts`, `src/handlers/token.ts`
**Discovery**: `src/handlers/discovery.ts` (subject_types_supported)
