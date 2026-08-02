import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import type { WorkerComponent } from '../core/naming.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';

const RUNTIME_COMPONENTS = [
  'ar-lib-core',
  'ar-discovery',
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
] as const satisfies readonly WorkerComponent[];

function smokeConfig() {
  const config = createDefaultConfig('smoke-test');
  config.keys.keyId = 'smoke-test-signing-key';
  config.urls = {
    api: { auto: 'https://smoke-test-ar-router.example.workers.dev' },
    loginUi: {
      auto: 'https://smoke-test-ar-login-ui.example.workers.dev',
      sameAsApi: false,
    },
    adminUi: {
      auto: 'https://smoke-test-ar-admin-ui.example.workers.dev',
      sameAsApi: false,
    },
  };
  return config;
}

describe('Control runtime smoke wrangler topology', () => {
  it.each(RUNTIME_COMPONENTS)(
    'adds private RPC identity and version observation to %s',
    (component) => {
      const generated = generateWranglerConfig(component, smokeConfig(), { d1: {}, kv: {} });

      expect(generated.version_metadata).toEqual({ binding: 'CONTROL_SMOKE_VERSION' });
      expect(generated.vars).toMatchObject({
        AUTHRIM_ENVIRONMENT_NAME: 'smoke-test',
        AUTHRIM_WORKER_SCRIPT_NAME: `smoke-test-${component}`,
      });

      const environmentToml = toToml(generated, 'smoke-test');
      expect(environmentToml).toContain('[env.smoke-test.version_metadata]');
      expect(environmentToml).toContain('binding = "CONTROL_SMOKE_VERSION"');
      expect(toToml(generated)).toContain('[version_metadata]');
    }
  );

  it('binds Control to every runtime through the named smoke entrypoint', () => {
    const generated = generateWranglerConfig('ar-control', smokeConfig(), { d1: {}, kv: {} });

    expect(generated.workers_dev).toBe(false);
    expect(generated.routes).toBeUndefined();
    expect(generated.vars).toMatchObject({
      AUTHRIM_ENVIRONMENT_NAME: 'smoke-test',
      SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
      SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-test-signing-key-control-smoke',
    });
    expect(generated.services).toHaveLength(RUNTIME_COMPONENTS.length);
    for (const component of RUNTIME_COMPONENTS) {
      expect(generated.services).toContainEqual({
        binding: `SMOKE_${component.replace(/^ar-/u, 'AR_').replaceAll('-', '_').toUpperCase()}`,
        service: `smoke-test-${component}`,
        entrypoint: 'RuntimeSmokeEntrypoint',
        props: {
          caller: 'ar-control',
          audience: 'authrim-runtime-smoke-v1',
          environmentId: 'smoke-test',
          targetWorker: `smoke-test-${component}`,
        },
      });
    }
  });

  it('can generate an initial Control config without unresolved smoke targets', () => {
    const generated = generateWranglerConfig(
      'ar-control',
      smokeConfig(),
      { d1: {}, kv: {} },
      undefined,
      { includeControlSmokeBindings: false }
    );

    expect(generated.services).toBeUndefined();
    expect(generated.triggers).toEqual({ crons: ['* * * * *'] });
    expect(generated.vars).toMatchObject({
      AUTHRIM_ENVIRONMENT_NAME: 'smoke-test',
      SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'A',
    });
  });

  it('uses Control-exported active key metadata instead of resetting rotation to slot A', () => {
    const resources = {
      d1: {},
      kv: {},
      controlKeyState: {
        runtimeRegistry: {
          activeSlot: 'B' as const,
          activeKeyId: 'registry-v2',
          activeFingerprint: 'a'.repeat(64),
          previousSlot: 'A' as const,
          previousKeyId: 'registry-v1',
          previousFingerprint: 'b'.repeat(64),
          updatedAt: 20,
        },
        smokeRpc: {
          activeSlot: 'B' as const,
          activeKeyId: 'smoke-v2',
          activeFingerprint: 'c'.repeat(64),
          previousSlot: 'A' as const,
          previousKeyId: 'smoke-v1',
          previousFingerprint: 'd'.repeat(64),
          updatedAt: 21,
        },
        lookupHmac: {
          stateRevision: 3,
          activeGeneration: 2,
          activeSlot: 'B' as const,
          activeKeyId: 'lookup-v2',
          activeFingerprint: 'e'.repeat(64),
          previousGeneration: 1,
          previousSlot: 'A' as const,
          previousKeyId: 'lookup-v1',
          previousFingerprint: 'f'.repeat(64),
          updatedAt: 22,
        },
      },
    };

    expect(generateWranglerConfig('ar-control', smokeConfig(), resources).vars).toMatchObject({
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'B',
      SMOKE_RPC_SIGNING_ACTIVE_SLOT: 'B',
      SMOKE_RPC_SIGNING_ACTIVE_KID: 'smoke-v2',
    });
    expect(generateWranglerConfig('ar-management', smokeConfig(), resources).vars).toMatchObject({
      LOOKUP_HMAC_ACTIVE_SLOT: 'B',
      LOOKUP_HMAC_ACTIVE_GENERATION: '2',
    });
  });

  it('does not expose the smoke entrypoint metadata on non-runtime Workers', () => {
    for (const component of ['ar-router'] as const) {
      const generated = generateWranglerConfig(component, smokeConfig(), { d1: {}, kv: {} });
      expect(generated.version_metadata).toBeUndefined();
      expect(generated.vars.AUTHRIM_WORKER_SCRIPT_NAME).toBeUndefined();
    }
  });

  it('exposes runtime smoke metadata on discovery because it resolves tenant Core', () => {
    const generated = generateWranglerConfig('ar-discovery', smokeConfig(), { d1: {}, kv: {} });

    expect(generated.version_metadata).toEqual({ binding: 'CONTROL_SMOKE_VERSION' });
    expect(generated.vars.AUTHRIM_WORKER_SCRIPT_NAME).toBe('smoke-test-ar-discovery');
  });
});
