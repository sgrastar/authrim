import type { Deps } from './types';
import { logError } from './log';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 2048;

/**
 * Verifies a Turnstile token with Cloudflare. Fails closed: any error, timeout, non-success answer
 * or hostname that is not the portal's own is a failure.
 */
export async function verifyTurnstile(
  deps: Deps,
  input: { secret: string; token: string; remoteIp: string | null; portalHost: string }
): Promise<boolean> {
  if (!input.token || input.token.length > MAX_TOKEN_LENGTH) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const form = new URLSearchParams({ secret: input.secret, response: input.token });
    if (input.remoteIp) form.set('remoteip', input.remoteIp);
    const response = await deps.fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = await response.json<{ success?: unknown; hostname?: unknown }>();
    if (result.success !== true) return false;
    if (result.hostname !== undefined && result.hostname !== input.portalHost) return false;
    return true;
  } catch {
    logError('turnstile_unavailable');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
