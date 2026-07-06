/**
 * Core Repositories (Non-PII)
 *
 * Repositories for data stored in D1_CORE database.
 * These repositories handle authentication and authorization data
 * without personal information.
 *
 * Included repositories:
 * - ClientRepository: OAuth 2.0 / OIDC clients
 * - SessionRepository: User sessions with expiration handling
 * - PasskeyRepository: WebAuthn credentials
 * - RoleRepository: RBAC roles and user-role assignments
 *
 * Future additions:
 * - OrganizationRepository: Multi-tenant organizations
 */

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
  TotpCredentialRepository,
  type TotpCredential,
  type TotpCredentialStatus,
  type CreateTotpCredentialInput,
  type TotpBackupCode,
  type CreateTotpBackupCodeInput,
} from './totp-credential';

export {
  RoleRepository,
  type Role,
  type UserRole,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './role';

export {
  SessionClientRepository,
  type SessionClient,
  type SessionClientWithDetails,
  type CreateSessionClientInput,
  type UpdateSessionClientInput,
} from './session-client';

export {
  DeviceSecretRepository,
  type CreateDeviceSecretResult,
  type DeviceSecretCreateOptions,
} from './device-secret';

export {
  DeviceInstallationRepository,
  type FindDeviceInstallationsOptions,
} from './device-installation';
