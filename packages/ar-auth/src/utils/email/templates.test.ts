import { describe, expect, it, vi } from 'vitest';
import { getEmailCodeHtml, getEmailCodeText } from './templates';

describe('email code templates', () => {
  const baseData = {
    name: 'Taylor',
    email: 'taylor@example.com',
    code: '123456',
    expiresInMinutes: 5,
    appName: 'Authrim',
    logoUrl: 'https://assets.example.com/logo.png',
  };

  it('renders branded HTML with the recipient, code, expiry, and logo', () => {
    vi.setSystemTime(new Date('2026-05-20T00:00:00Z'));

    const html = getEmailCodeHtml(baseData);

    expect(html).toContain('<title>Your verification code for Authrim</title>');
    expect(html).toContain('<img src="https://assets.example.com/logo.png"');
    expect(html).toContain('Hello Taylor,');
    expect(html).toContain('taylor@example.com');
    expect(html).toContain('<div class="code">123456</div>');
    expect(html).toContain('valid for 5 minutes');
    expect(html).toContain('2026 Authrim');
  });

  it('omits optional personalization when name and logo are absent', () => {
    const html = getEmailCodeHtml({
      ...baseData,
      name: undefined,
      logoUrl: undefined,
    });

    expect(html).toContain('<p class="greeting">Hello,</p>');
    expect(html).not.toContain('<img src=');
  });

  it('renders a plain-text fallback with the same security-critical details', () => {
    vi.setSystemTime(new Date('2026-05-20T00:00:00Z'));

    const text = getEmailCodeText(baseData);

    expect(text).toContain('Hello Taylor,');
    expect(text).toContain('sign in to your Authrim account (taylor@example.com)');
    expect(text).toContain('Your verification code is: 123456');
    expect(text).toContain('valid for 5 minutes');
    expect(text).toContain('2026 Authrim');
    expect(text).not.toMatch(/^\s|\s$/);
  });

  it('escapes HTML fields and drops unsafe logo URLs', () => {
    const html = getEmailCodeHtml({
      ...baseData,
      name: '<img src=x onerror=alert(1)>',
      email: 'attacker@example.com"><script>alert(1)</script>',
      code: '<123456>',
      appName: 'Authrim <script>alert(1)</script>',
      logoUrl: 'javascript:alert(1)',
    });

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('attacker@example.com&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;123456&gt;');
    expect(html).toContain('Authrim &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:alert');
    expect(html).not.toContain('<img src=');
  });

  it('drops non-HTTPS logo URLs', () => {
    const html = getEmailCodeHtml({
      ...baseData,
      logoUrl: 'http://assets.example.com/logo.png',
    });

    expect(html).not.toContain('<img src=');
    expect(html).not.toContain('http://assets.example.com/logo.png');
  });
});
