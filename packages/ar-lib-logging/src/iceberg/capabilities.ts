/** Activated only after producer, search, retention and DR integration pass. */
export type LogArchiveMode = 'pipeline' | 'scheduled';
export const LOG_ARCHIVE_SCHEMA_VERSION = 1;
export const LOG_ARCHIVE_IMPLEMENTED_MODES: readonly LogArchiveMode[] = Object.freeze([]);

/** Shared producer identity contract for Setup, internal RPC and coverage. */
export const LOG_ARCHIVE_PRODUCER_COMPONENTS = [
  'ar-lib-core',
  'ar-auth',
  'ar-token',
  'ar-userinfo',
  'ar-management',
  'ar-agent-access',
  'ar-async',
  'ar-policy',
  'ar-saml',
  'ar-bridge',
  'ar-vc',
  'ar-plugin-runner',
] as const;
