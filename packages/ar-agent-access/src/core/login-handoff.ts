import { sha256Base64Url } from './canonical-json';

export const ADMIN_AGENT_LOGIN_HANDOFF_ID_PATTERN = /^alh_[A-Za-z0-9_-]{32}$/u;
export const ADMIN_AGENT_LOGIN_HANDOFF_CODE_PATTERN = /^ahc_[A-Za-z0-9_-]{43}$/u;
export const ADMIN_AGENT_LOGIN_HANDOFF_CODE_TTL_MS = 60_000;

export function hashAdminAgentLoginHandoffBrowserBinding(
  handoffId: string,
  secret: string
): Promise<string> {
  return sha256Base64Url(`authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${secret}`);
}

export function hashAdminAgentLoginHandoffCode(code: string): Promise<string> {
  return sha256Base64Url(`authrim-admin-agent-handoff-code-v1\0${code}`);
}

export function hashAdminAgentLoginHandoffSession(sessionId: string): Promise<string> {
  return sha256Base64Url(`authrim-admin-agent-handoff-session-v1\0${sessionId}`);
}

export function buildAdminAgentLoginHandoffConsumeUrl(targetOrigin: string, code: string): string {
  if (!ADMIN_AGENT_LOGIN_HANDOFF_CODE_PATTERN.test(code)) {
    throw new TypeError('Invalid Admin Agent login handoff code');
  }
  const target = new URL('/oauth/admin-agent/login-handoff/consume', targetOrigin);
  if (
    target.protocol !== 'https:' ||
    target.username !== '' ||
    target.password !== '' ||
    target.origin !== targetOrigin
  ) {
    throw new TypeError('Invalid Admin Agent login handoff target origin');
  }
  target.searchParams.set('code', code);
  return target.toString();
}
