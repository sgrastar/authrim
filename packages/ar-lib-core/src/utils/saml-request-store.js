/**
 * SAMLRequestStore Durable Object routing helpers.
 *
 * SAML request correlation must be scoped by tenant, Authrim's SAML role, and
 * the counterparty entityID. Do not shard by user: AuthnRequest correlation is
 * created before a user may be known, and response validation must route to the
 * same DO instance as the original request.
 */

/**
 * Build a SAMLRequestStore Durable Object instance name.
 *
 * Format:
 * - tenant:{tenantId}:saml:idp:sp:{encodedSpEntityId}
 * - tenant:{tenantId}:saml:sp:idp:{encodedIdpEntityId}
 */
export function buildSAMLRequestStoreInstanceName(tenantId, authrimRole, counterpartyEntityId) {
    const counterpartyRole = authrimRole === 'idp' ? 'sp' : 'idp';
    return `tenant:${tenantId}:saml:${authrimRole}:${counterpartyRole}:${encodeURIComponent(counterpartyEntityId)}`;
}
