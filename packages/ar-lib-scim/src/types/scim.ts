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
} as const;

/**
 * SCIM Resource Meta Information
 */
export interface ScimMeta {
  resourceType: 'User' | 'Group';
  created: string; // ISO 8601 timestamp
  lastModified: string; // ISO 8601 timestamp
  location: string; // Resource URI
  version?: string; // ETag value for versioning
}

/**
 * SCIM Name Structure
 */
export interface ScimName {
  formatted?: string;
  familyName?: string;
  givenName?: string;
  middleName?: string;
  honorificPrefix?: string;
  honorificSuffix?: string;
}

/**
 * SCIM Email Address
 */
export interface ScimEmail {
  value: string;
  type?: string; // e.g., "work", "home"
  primary?: boolean;
  display?: string;
}

/**
 * SCIM Phone Number
 */
export interface ScimPhoneNumber {
  value: string;
  type?: string; // e.g., "work", "mobile", "home"
  primary?: boolean;
}

/**
 * SCIM Address
 */
export interface ScimAddress {
  formatted?: string;
  streetAddress?: string;
  locality?: string; // City
  region?: string; // State/Province
  postalCode?: string;
  country?: string;
  type?: string; // e.g., "work", "home"
  primary?: boolean;
}

/**
 * SCIM Group Member Reference
 */
export interface ScimGroupMember {
  value: string; // User or Group ID
  $ref?: string; // Full URI to the resource
  type?: 'User' | 'Group';
  display?: string;
}

/**
 * SCIM User Resource (RFC 7643 Section 4.1)
 */
export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: ScimName;
  displayName?: string;
  nickName?: string;
  profileUrl?: string;
  title?: string;
  userType?: string;
  preferredLanguage?: string;
  locale?: string;
  timezone?: string;
  active?: boolean;
  password?: string; // Write-only
  emails?: ScimEmail[];
  phoneNumbers?: ScimPhoneNumber[];
  addresses?: ScimAddress[];
  groups?: Array<{
    value: string;
    $ref?: string;
    display?: string;
    type?: string;
  }>;
  meta: ScimMeta;

  // Enterprise User Extension (optional)
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'?: {
    employeeNumber?: string;
    costCenter?: string;
    organization?: string;
    division?: string;
    department?: string;
    manager?: {
      value?: string;
      $ref?: string;
      displayName?: string;
    };
  };
}

/**
 * SCIM Group Resource (RFC 7643 Section 4.2)
 */
export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members?: ScimGroupMember[];
  meta: ScimMeta;
}

/**
 * SCIM List Response (RFC 7644 Section 3.4.2)
 */
export interface ScimListResponse<T = ScimUser | ScimGroup> {
  schemas: string[];
  totalResults: number;
  startIndex: number; // 1-based index
  itemsPerPage: number;
  Resources: T[];
}

/**
 * SCIM Error Response (RFC 7644 Section 3.12)
 */
export interface ScimError {
  schemas: string[];
  status: string | number; // HTTP status code
  scimType?: ScimErrorType;
  detail?: string;
}

/**
 * SCIM Error Types
 */
export type ScimErrorType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

/**
 * SCIM Patch Operation Value Type (RFC 7644 Section 3.5.2)
 *
 * The value can be:
 * - Primitive: string, number, boolean, null
 * - Complex: A single object with attribute key-value pairs
 * - Multi-valued: An array of primitives or objects
 */
export type ScimPatchValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

/**
 * SCIM Filter Value Type (RFC 7644 Section 3.4.2.2)
 *
 * Filter comparison operands are limited to primitive types.
 */
export type ScimFilterValue = string | number | boolean | null;

/**
 * SCIM Patch Operation (RFC 7644 Section 3.5.2)
 */
export interface ScimPatchOp {
  schemas: string[];
  Operations: Array<{
    op: 'add' | 'remove' | 'replace';
    path?: string;
    value?: ScimPatchValue;
  }>;
}

/**
 * SCIM Filter Operators
 */
export type ScimFilterOperator =
  | 'eq' // Equal
  | 'ne' // Not equal
  | 'co' // Contains
  | 'sw' // Starts with
  | 'ew' // Ends with
  | 'pr' // Present (has value)
  | 'gt' // Greater than
  | 'ge' // Greater than or equal
  | 'lt' // Less than
  | 'le'; // Less than or equal

/**
 * SCIM Filter AST Node
 */
export interface ScimFilterNode {
  type: 'comparison' | 'logical' | 'grouping' | 'valuePath';
  operator?: ScimFilterOperator | 'and' | 'or' | 'not';
  attribute?: string;
  /** Filter comparison value (primitives only) or sub-attribute path for valuePath nodes */
  value?: ScimFilterValue | string;
  left?: ScimFilterNode;
  right?: ScimFilterNode;
  expression?: ScimFilterNode;
}

/**
 * SCIM Resource Type Definition
 */
export interface ScimResourceType {
  schemas: string[];
  id: string;
  name: string;
  endpoint: string;
  description?: string;
  schema: string;
  schemaExtensions?: Array<{
    schema: string;
    required: boolean;
  }>;
  meta: {
    location: string;
    resourceType: 'ResourceType';
  };
}

/**
 * SCIM Schema Definition
 */
export interface ScimSchemaDefinition {
  id: string;
  name: string;
  description?: string;
  attributes: ScimAttributeDefinition[];
  meta: {
    resourceType: 'Schema';
    location: string;
  };
}

/**
 * SCIM Attribute Definition
 */
export interface ScimAttributeDefinition {
  name: string;
  type: 'string' | 'boolean' | 'decimal' | 'integer' | 'dateTime' | 'reference' | 'complex';
  multiValued: boolean;
  description?: string;
  required: boolean;
  caseExact?: boolean;
  mutability?: 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
  returned?: 'always' | 'never' | 'default' | 'request';
  uniqueness?: 'none' | 'server' | 'global';
  subAttributes?: ScimAttributeDefinition[];
  referenceTypes?: string[];
}

/**
 * SCIM Service Provider Configuration
 */
export interface ScimServiceProviderConfig {
  schemas: string[];
  documentationUri?: string;
  patch: {
    supported: boolean;
  };
  bulk?: {
    supported: boolean;
    maxOperations?: number;
    maxPayloadSize?: number;
  };
  filter: {
    supported: boolean;
    maxResults?: number;
  };
  changePassword?: {
    supported: boolean;
  };
  sort?: {
    supported: boolean;
  };
  etag?: {
    supported: boolean;
  };
  authenticationSchemes: Array<{
    type: string;
    name: string;
    description: string;
    specUri?: string;
    documentationUri?: string;
    primary?: boolean;
  }>;
  meta: {
    location: string;
    resourceType: 'ServiceProviderConfig';
  };
}

/**
 * SCIM Query Parameters
 */
export interface ScimQueryParams {
  filter?: string;
  sortBy?: string;
  sortOrder?: 'ascending' | 'descending';
  startIndex?: number; // 1-based
  count?: number;
  attributes?: string[];
  excludedAttributes?: string[];
}

/**
 * Internal User to SCIM User Mapping Context
 */
export interface UserToScimContext {
  baseUrl: string;
  includeGroups?: boolean;
}

/**
 * Internal Group to SCIM Group Mapping Context
 */
export interface GroupToScimContext {
  baseUrl: string;
  includeMembers?: boolean;
}

// =============================================================================
// Bulk Operations (RFC 7644 Section 3.7)
// =============================================================================

/**
 * SCIM Bulk Request Schema URN
 */
export const SCIM_BULK_SCHEMAS = {
  BULK_REQUEST: 'urn:ietf:params:scim:api:messages:2.0:BulkRequest',
  BULK_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:BulkResponse',
} as const;

/**
 * SCIM Bulk Operation Method
 */
export type ScimBulkMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * SCIM Bulk Operation (RFC 7644 Section 3.7.2)
 *
 * Represents a single operation within a bulk request.
 */
export interface ScimBulkOperation {
  /** HTTP method for this operation */
  method: ScimBulkMethod;
  /** Temporary identifier for referencing newly created resources */
  bulkId?: string;
  /** Resource version for optimistic locking (If-Match header value) */
  version?: string;
  /** Resource path (e.g., "/Users" or "/Users/123") */
  path: string;
  /** Request body data for POST, PUT, PATCH operations */
  data?: Record<string, unknown>;
}

/**
 * SCIM Bulk Request (RFC 7644 Section 3.7.2)
 */
export interface ScimBulkRequest {
  schemas: string[];
  /** Number of errors before processing stops (default: 0 = fail fast) */
  failOnErrors?: number;
  Operations: ScimBulkOperation[];
}

/**
 * SCIM Bulk Operation Response (RFC 7644 Section 3.7.3)
 *
 * Represents the result of a single operation.
 */
export interface ScimBulkOperationResponse {
  /** HTTP method that was performed */
  method: ScimBulkMethod;
  /** bulkId from the request (for POST operations) */
  bulkId?: string;
  /** Version of the resource after operation (ETag) */
  version?: string;
  /** Resource location URI after operation */
  location?: string;
  /** HTTP status code string (e.g., "201", "404") */
  status: string;
  /** Response body (for successful operations) */
  response?: Record<string, unknown>;
}

/**
 * SCIM Bulk Response (RFC 7644 Section 3.7.3)
 */
export interface ScimBulkResponse {
  schemas: string[];
  Operations: ScimBulkOperationResponse[];
}

/**
 * Bulk operation configuration limits
 */
export interface BulkOperationConfig {
  /** Maximum number of operations per bulk request (default: 100) */
  maxOperations: number;
  /** Maximum payload size in bytes (default: 1048576 = 1MB) */
  maxPayloadSize: number;
}
