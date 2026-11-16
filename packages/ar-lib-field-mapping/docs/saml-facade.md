# SAML Mapping Set facade

The Mapping Set facade accepts one release protocol and exactly one Destination Profile per set.
The protocol is derived from the profile's destinationType; requests do not duplicate it. All
output targets, including graph edges and identifier outputs, must belong to that profile.
OIDC uses oidc.claim. SAML uses saml.attribute and saml.nameid. Inbound mapping is outside this facade.

SAML saves activate one version with `{protocol: "saml", role: "idp"}`. There is no SP selector in
the activation scope and no multi-activation. Each SP binds the set through
identityMapping.fieldMappingSetId. A save applies to all bound SPs. Existing Idempotency-Key,
If-Match/content_version and confirm_impact behavior remains in force. Reference counts include
OIDC clients and SAML SPs through the shared reference scanner. A referenced set cannot change its
protocol or profile: PUT returns 409 with referrers even when confirm_impact matches. Create another
set to change that identity. Preview-change is read-only and may describe a profile change that
cannot be saved while references remain.

GET /api/admin/identity-mapping/sets/{id} adds protocol, destination_profile_id and
destination_profile (the active consent descriptor, including fields). A console uses these field
keys to maintain the SP's destinationFieldPolicies. An SP binding requires an active compiled
SAML set, a SAML profile, matching output namespaces and exact policy coverage of its fields.
Incomplete legacy low-level sets remain readable with null destination metadata. Platform SAML
sets retain the platform catalog/source restrictions; the facade permits their shared protocol
scope internally without extending the low-level activation API.

SAML persistent identifiers cannot use a sector audience. A saml.nameid rule outputs either a
plain copy with no transform or one persistent_identifier step with format plain. The actual SSO
pipeline resolves that NameID after approval; a missing, invalid or suppressed value fails issuance.
Mapped NameIDs retain the existing persistent NameID format, including plain copies. NameID is
separate from attributes, even if its profile field has an attribute policy of hidden.

POST /api/admin/identity-mapping/explain accepts the existing OIDC request or
`{sp_entity_id, subject: {kind: "test_user", id}, consent?: "all" | "none" | "required"}`.
SAML returns before_consent items and deferred attribute names, then after_consent attributes and
NameID format/value or suppression/failure reasons. It uses computeSAMLAttributeRelease,
samlReleaseItems, applySAMLReleaseApproval and resolveSAMLMappedNameID, as SSO does. Test fixtures
never read account evidence, identifier stores or identifier secrets: persistent identifiers are
placeholders before approval (never returned as values) and suppressed after approval with an
explicit test-user reason. A fixture explanation does not issue an assertion or generate an
Authrim persistent/transient NameID. Fixture plain-copy NameIDs and ordinary attributes are evaluated.
Required missing fields fail through the same release validators; hidden attributes are omitted.

POST /api/admin/identity-mapping/sets/{id}/preview-change uses the W1b stored graph and dependency
analysis for both protocols. SAML answers include protocol=saml and sps with provider_id,
sp_entity_id, changes and held_back. Changes identify the saml.attribute or saml.nameid namespace.
Hidden attribute outputs and version-pinned bindings are held back. Shared reference counts and
scan completeness remain explicit. Draft sample execution remains unavailable until draft compilation
is supported. The console should use this facade; no new version-endpoint workflow is introduced.

The ar-saml/release-explain package entry provides an explicit declaration contract for the fixture
runner and SP binding check. Management calls that boundary instead of importing internal XML
compiler types; the actual SAML release and provider validation implementations remain shared.

The SAML profile nameId definition supplies NameID classification independently of attributes.
GET includes that definition as destination_profile.nameId. Plain copies do not require an
artificial attribute or a destinationFieldPolicies entry for NameID; copying a sensitive field
requires a matching or higher nameId.classification. Legacy attribute-based NameID profiles remain
readable.

An SP may select an active set owned by its own tenant or by the platform. Registration and
runtime resolve that owner before loading the activation; another tenant's set is unavailable.
The release still runs in the calling tenant's context, including its institution and user.
Attributes and plain-copy NameIDs share trusted institution/assurance subject enrichment.
Fixture enrichment never reads user evidence; flat fixture fields are also available under
customFields for authrim.custom_fields sources.

SAML preview-change reports unresolved_sp_references for federation trust sources whose
automatically resolved SPs cannot be enumerated. Such a response has usage_complete=false even
when the stored-reference scan is complete; its sps list covers only known persisted providers.
