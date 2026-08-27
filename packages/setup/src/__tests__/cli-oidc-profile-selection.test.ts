import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';

describe('CLI OIDC profile setup contract', () => {
  it('uses the basic OP default without exposing a non-functional profile selector', () => {
    const source = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');

    expect(createDefaultConfig('test').profile).toBe('basic-op');
    expect(source).not.toContain("t('profile.prompt')");
    expect(source).not.toContain("value: 'profile'");
    expect(source).not.toContain('async function editProfile');
  });

  it('does not hard-code English copy in the new-environment domain flow', () => {
    const source = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');
    const removedEnglishCopy = [
      'Leave empty to use workers.dev and single-tenant mode.',
      'Tenant ID rules:',
      'Tip: A random tenant ID',
      'Generate a random tenant ID?',
      'Use naked domain as the issuer',
      'Primary tenant ID for naked domain',
      'Workers Paid Plan required',
      'Start setup with this configuration?',
      'Setup cancelled.',
    ];

    for (const copy of removedEnglishCopy) {
      expect(source).not.toContain(copy);
    }
  });

  it('does not hard-code English copy in initial provisioning and completion', () => {
    const source = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');
    const initialProvisioning = source.slice(
      source.indexOf('async function executeSetup('),
      source.indexOf('// Handle Existing Config')
    );
    const removedEnglishCopy = [
      'Running Setup...',
      'Checking wrangler status...',
      'Existing keys will be overwritten.',
      'Creating Cloudflare resources...',
      'Generating lock file...',
      'Generating UI environment file...',
      'Saving wrangler.toml master configs...',
      'Created Resources:',
      'Generated Files:',
      'Next Steps:',
      'Apply schemas and deploy the complete release:',
      'Automatic provisioning is OFF',
    ];

    for (const copy of removedEnglishCopy) {
      expect(initialProvisioning).not.toContain(copy);
    }
  });

  it('keeps R2 enabled without prompting during new-environment setup', () => {
    const source = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');

    expect(source).not.toContain("message: t('features.r2Prompt')");
    expect(source).toContain('const enableR2 = true;');
    expect(createDefaultConfig('test').features.r2).toEqual({ enabled: true });
  });

  it('uses Web-equivalent recommended OIDC and data-protection defaults without questions', () => {
    const source = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');
    const defaults = createDefaultConfig('test');

    expect(source).not.toContain("message: t('oidc.configurePrompt')");
    expect(source).not.toContain("message: t('security.piiEncryption')");
    expect(source).not.toContain("message: t('security.domainHash')");
    expect(defaults.oidc).toMatchObject({
      accessTokenTtl: 3600,
      refreshTokenTtl: 604800,
      authCodeTtl: 600,
      pkceRequired: true,
    });
    expect(defaults.security).toEqual({
      piiEncryptionEnabled: true,
      domainHashEnabled: true,
    });
  });

  it('does not collect or persist a second Cloudflare API token during init', () => {
    const initSource = readFileSync(new URL('../cli/commands/init.ts', import.meta.url), 'utf8');
    const deploySource = readFileSync(
      new URL('../cli/commands/deploy.ts', import.meta.url),
      'utf8'
    );

    expect(initSource).not.toContain('promptCloudflareCustomHostnameToken');
    expect(initSource).not.toContain('cloudflare_api_token.txt');
    expect(deploySource).toContain('await promptForControlTokenBootstrap({');
  });
});
