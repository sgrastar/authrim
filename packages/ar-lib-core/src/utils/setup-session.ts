/**
 * Setup Session Utilities
 *
 * Manages temporary sessions for initial admin setup.
 * These sessions are short-lived (5 minutes) and only allow Passkey registration.
 * Once Passkey is registered, the temporary session is upgraded to a full session.
 */

import type { Env } from '../types/env';
import { generateSecureRandomString } from './crypto';

/** Prefix for setup session keys in KV */
const SETUP_SESSION_PREFIX = 'setup:session:';

/** Default setup session TTL in seconds (5 minutes) */
const DEFAULT_SETUP_SESSION_TTL = 300;

/**
 * Setup session data stored in KV
 */
export interface SetupSessionData {
  /** User ID of the admin being created */
  userId: string;
  /** Email address of the admin */
  email: string;
  /** Optional display name */
  name?: string;
  /** Setup token ID for Admin UI passkey registration */
  setupTokenId?: string;
  /** Timestamp when the session was created */
  createdAt: number;
  /** Purpose of the session (always 'passkey_registration' for now) */
  purpose: 'passkey_registration';
}

/**
 * Validation result for setup session
 */
export interface SetupSessionValidationResult {
  valid: boolean;
  data?: SetupSessionData;
  reason?: 'no_session' | 'expired' | 'invalid';
}

/**
 * Create a temporary setup session for Passkey registration
 *
 * This session is used to bridge the gap between user creation and Passkey registration.
 * It's short-lived and can only be used for the specific purpose of registering a Passkey.
 *
 * @param env - Cloudflare Workers environment
 * @param data - Session data to store
 * @param ttlSeconds - Session TTL in seconds (default: 5 minutes)
 * @returns The session token
 */
export async function createSetupSession(
  env: Env,
  data: Omit<SetupSessionData, 'createdAt' | 'purpose'>,
  ttlSeconds: number = DEFAULT_SETUP_SESSION_TTL
): Promise<string> {
  if (!env.AUTHRIM_CONFIG) {
    throw new Error('AUTHRIM_CONFIG KV namespace is not available');
  }

  // Generate a cryptographically secure session token
  const token = generateSecureRandomString(32);
  const key = `${SETUP_SESSION_PREFIX}${token}`;

  const sessionData: SetupSessionData = {
    ...data,
    createdAt: Date.now(),
    purpose: 'passkey_registration',
  };

  await env.AUTHRIM_CONFIG.put(key, JSON.stringify(sessionData), {
    expirationTtl: ttlSeconds,
  });

  return token;
}

/**
 * Validate a setup session token
 *
 * @param env - Cloudflare Workers environment
 * @param token - The session token to validate
 * @returns Validation result with session data if valid
 */
export async function validateSetupSession(
  env: Env,
  token: string
): Promise<SetupSessionValidationResult> {
  if (!env.AUTHRIM_CONFIG) {
    return { valid: false, reason: 'no_session' };
  }

  const key = `${SETUP_SESSION_PREFIX}${token}`;
  const data = await env.AUTHRIM_CONFIG.get(key);

  if (!data) {
    return { valid: false, reason: 'no_session' };
  }

  try {
    const sessionData = JSON.parse(data) as SetupSessionData;
    return { valid: true, data: sessionData };
  } catch {
    return { valid: false, reason: 'invalid' };
  }
}

/**
 * Delete a setup session
 *
 * Called after Passkey registration is complete to clean up the temporary session.
 *
 * @param env - Cloudflare Workers environment
 * @param token - The session token to delete
 */
export async function deleteSetupSession(env: Env, token: string): Promise<void> {
  if (!env.AUTHRIM_CONFIG) {
    return;
  }

  const key = `${SETUP_SESSION_PREFIX}${token}`;
  await env.AUTHRIM_CONFIG.delete(key);
}
