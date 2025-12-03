/**
 * @authrim/scim - SCIM 2.0 Protocol Implementation
 *
 * This package provides SCIM 2.0 (RFC 7643, RFC 7644) utilities for
 * user and group provisioning in enterprise environments.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7643 - SCIM Core Schema
 * @see https://datatracker.ietf.org/doc/html/rfc7644 - SCIM Protocol
 */

// Types
export * from './types/scim';

// Utils
export * from './utils/scim-filter';
export * from './utils/scim-mapper';

// Middleware
export * from './middleware/scim-auth';
