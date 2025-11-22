/**
 * SCIM 2.0 Type Definitions
 *
 * Implements RFC 7643 (SCIM Core Schema) and RFC 7644 (SCIM Protocol)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7643
 * @see https://datatracker.ietf.org/doc/html/rfc7644
 */
/**
 * SCIM Schema URNs
 */
export const SCIM_SCHEMAS = {
    USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
    GROUP: 'urn:ietf:params:scim:schemas:core:2.0:Group',
    ENTERPRISE_USER: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    LIST_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
    ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
    PATCH_OP: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
    RESOURCE_TYPE: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
    SCHEMA: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
    SERVICE_PROVIDER_CONFIG: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
};
