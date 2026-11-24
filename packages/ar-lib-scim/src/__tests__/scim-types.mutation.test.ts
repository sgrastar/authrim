/**
 * SCIM schema URN constants - mutation-hardening tests
 */

import { describe, it, expect } from 'vitest';
import { SCIM_SCHEMAS, SCIM_BULK_SCHEMAS } from '../types/scim';

describe('SCIM schema URNs', () => {
  it('matches the RFC 7643 / RFC 7644 URNs', () => {
    expect(SCIM_SCHEMAS.USER).toBe('urn:ietf:params:scim:schemas:core:2.0:User');
    expect(SCIM_SCHEMAS.GROUP).toBe('urn:ietf:params:scim:schemas:core:2.0:Group');
    expect(SCIM_SCHEMAS.LIST_RESPONSE).toBe('urn:ietf:params:scim:api:messages:2.0:ListResponse');
    expect(SCIM_SCHEMAS.ERROR).toBe('urn:ietf:params:scim:api:messages:2.0:Error');
    expect(SCIM_SCHEMAS.PATCH_OP).toBe('urn:ietf:params:scim:api:messages:2.0:PatchOp');
    expect(SCIM_SCHEMAS.RESOURCE_TYPE).toBe('urn:ietf:params:scim:schemas:core:2.0:ResourceType');
    expect(SCIM_SCHEMAS.SCHEMA).toBe('urn:ietf:params:scim:schemas:core:2.0:Schema');
    expect(SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG).toBe(
      'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'
    );
  });

  it('matches the bulk URNs', () => {
    expect(SCIM_BULK_SCHEMAS).toEqual({
      BULK_REQUEST: 'urn:ietf:params:scim:api:messages:2.0:BulkRequest',
      BULK_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:BulkResponse',
    });
  });
});
