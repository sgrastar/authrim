import { describe, expect, it } from 'vitest';
import { validateLoginUICustomCss } from '../login-ui-css-validator';

describe('validateLoginUICustomCss', () => {
  it('allows simple Login UI selectors and safe declarations', () => {
    const result = validateLoginUICustomCss(`
      [data-theme='dark'] .auth-page {
        background-color: #111111;
        --login-page-overlay: linear-gradient(90deg, rgba(0, 0, 0, 0.4), transparent);
      }
      .auth-container .btn:hover {
        border-radius: 12px;
        color: white;
      }
    `);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.sanitizedCss).toContain("[data-theme='dark'] .auth-page");
    expect(result.sanitizedCss).toContain('--login-page-overlay');
    expect(result.sanitizedCss).toContain('.auth-container .btn:hover');
  });

  it('allows theme page-shell selectors used by Login UI templates', () => {
    const result = validateLoginUICustomCss(`
      [data-login-theme='fullbleed-glass'] .auth-page {
        min-height: 100vh;
      }
      [data-topbar-position='bottom_right'] .auth-topbar {
        position: fixed;
        right: 20px;
        bottom: 20px;
      }
      [data-header-style='bar'] .auth-header {
        display: flex;
      }
      [data-split-background-mode='panel'][data-has-login-panel-background-image='true'] .auth-container {
        opacity: 0.95;
      }
    `);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.sanitizedCss).toContain("[data-login-theme='fullbleed-glass'] .auth-page");
    expect(result.sanitizedCss).toContain("[data-topbar-position='bottom_right'] .auth-topbar");
    expect(result.sanitizedCss).toContain("[data-split-background-mode='panel']");
  });

  it('rejects selectors outside the Login UI allowlist', () => {
    const result = validateLoginUICustomCss('body { background: #fff; }');

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Selector is not allowed');
  });

  it('rejects unsafe value channels and at-rules', () => {
    expect(validateLoginUICustomCss(".auth-page { background-image: url('x'); }").valid).toBe(
      false
    );
    expect(validateLoginUICustomCss("@import url('https://example.com/a.css');").valid).toBe(false);
    expect(validateLoginUICustomCss('.auth-page { color: expression(alert(1)); }').valid).toBe(
      false
    );
  });

  it('rejects arbitrary custom properties', () => {
    const result = validateLoginUICustomCss('.auth-page { --third-party-token: red; }');

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('Declaration is not allowed');
  });

  it('rejects comments and nested or partial CSS', () => {
    expect(validateLoginUICustomCss('.auth-page { color: red; /* hidden */ }').valid).toBe(false);
    expect(validateLoginUICustomCss('.auth-page { color: red; } .x').valid).toBe(false);
  });
});
