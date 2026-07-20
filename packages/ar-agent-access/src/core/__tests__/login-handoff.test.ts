import { describe, expect, it } from 'vitest';
import {
  buildAdminAgentLoginHandoffConsumeUrl,
  hashAdminAgentLoginHandoffBrowserBinding,
  hashAdminAgentLoginHandoffCode,
  hashAdminAgentLoginHandoffSession,
} from '../login-handoff';

const handoffId = `alh_${'a'.repeat(32)}`;
const code = `ahc_${'b'.repeat(43)}`;

describe('Admin Agent login handoff primitives', () => {
  it('domain-separates browser, code, and source-session hashes', async () => {
    const [browser, codeHash, session] = await Promise.all([
      hashAdminAgentLoginHandoffBrowserBinding(handoffId, 'secret'),
      hashAdminAgentLoginHandoffCode(code),
      hashAdminAgentLoginHandoffSession('secret'),
    ]);
    expect(new Set([browser, codeHash, session]).size).toBe(3);
    expect(browser).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(codeHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('builds only the fixed HTTPS target consume URL', () => {
    expect(buildAdminAgentLoginHandoffConsumeUrl('https://tenant.example.com', code)).toBe(
      `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${code}`
    );
    expect(() =>
      buildAdminAgentLoginHandoffConsumeUrl('http://tenant.example.com', code)
    ).toThrow();
    expect(() =>
      buildAdminAgentLoginHandoffConsumeUrl('https://user@tenant.example.com', code)
    ).toThrow();
    expect(() =>
      buildAdminAgentLoginHandoffConsumeUrl('https://tenant.example.com/path', code)
    ).toThrow();
    expect(() =>
      buildAdminAgentLoginHandoffConsumeUrl('https://tenant.example.com', 'ahc_short')
    ).toThrow();
  });
});
