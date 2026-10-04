// Session lifetimes are shared with the Admin API (compliance shows them); ar-auth keeps this
// module so its handlers and tests import one seam.
export {
  resolveSessionExtensionPolicy,
  resolveSessionTtl,
  SESSION_TTL_DEFINITIONS,
  type SessionTtlContext,
  type SessionTtlDefinition,
  type SessionTtlResolution,
} from '@authrim/ar-lib-core';
