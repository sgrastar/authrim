/**
 * Core Repositories (Non-PII)
 *
 * Repositories for data stored in D1_CORE database.
 * These repositories handle authentication and authorization data
 * without personal information.
 *
 * Included repositories:
 * - UserCoreRepository: Core user data (pii_partition, pii_status, etc.)
 * - ClientRepository: OAuth 2.0 / OIDC clients
 * - SessionRepository: User sessions with expiration handling
 * - PasskeyRepository: WebAuthn credentials
 * - RoleRepository: RBAC roles and user-role assignments
 *
 * Future additions:
 * - OrganizationRepository: Multi-tenant organizations
 */

export {
  UserCoreRepository,
  type UserCore,
  type CreateUserCoreInput,
  type UpdateUserCoreInput,
  type UserCoreFilterOptions,
  type CoreUserType,
} from './user-core';

export {
  ClientRepository,
  type OAuthClient,
  type CreateClientInput,
  type UpdateClientInput,
  type ClientFilterOptions,
} from './client';

export {
  SessionRepository,
  type Session,
  type CreateSessionInput,
  type UpdateSessionInput,
  type SessionFilterOptions,
} from './session';

export {
  PasskeyRepository,
  type Passkey,
  type CreatePasskeyInput,
  type UpdatePasskeyInput,
  type PasskeyFilterOptions,
  type AuthenticatorTransport,
} from './passkey';

export {
  RoleRepository,
  type Role,
  type UserRole,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './role';
