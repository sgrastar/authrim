import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { WORKER_COMPONENTS } from '../core/naming.js';
import { generateWranglerConfig } from '../core/wrangler.js';

function drConfig() {
  const config = createDefaultConfig('dr-test');
  config.urls = {
    api: { auto: 'https://dr-test-ar-router.example.workers.dev' },
    loginUi: { auto: 'https://dr-test-ar-login-ui.example.workers.dev', sameAsApi: false },
    adminUi: { auto: 'https://dr-test-ar-admin-ui.example.workers.dev', sameAsApi: false },
  };
  return config;
}

describe('opt-in SAML DR writer topology', () => {
  it.each(WORKER_COMPONENTS)('preserves default %s bindings and flags', (component) => {
    const config = drConfig();
    const generated = generateWranglerConfig(component, config, { d1: {}, kv: {} });
    expect(config.features.samlDrExport?.enabled ?? false).toBe(false);
    expect(generated.vars.ENABLE_SAML_DR_EXPORT).toBeUndefined();
    expect(generated.services?.some((s) => s.binding === 'SAML_DR_MUTATION_CONTROL')).not.toBe(
      true
    );
  });
  it.each(WORKER_COMPONENTS)(
    'installs exact admission/probe identity for %s only when opted in',
    (component) => {
      const config = drConfig();
      config.features.samlDrExport = { enabled: true };
      const generated = generateWranglerConfig(component, config, { d1: {}, kv: {} });
      expect(generated.vars).toMatchObject({
        ENABLE_SAML_DR_EXPORT: 'true',
        AUTHRIM_ENVIRONMENT_NAME: 'dr-test',
        AUTHRIM_WORKER_SCRIPT_NAME: `dr-test-${component}`,
      });
      expect(generated.version_metadata).toEqual({ binding: 'CONTROL_SMOKE_VERSION' });
      if (component === 'ar-control') {
        for (const target of WORKER_COMPONENTS) {
          expect(generated.services).toContainEqual({
            binding: `SMOKE_${target.replaceAll('-', '_').toUpperCase()}`,
            service: `dr-test-${target}`,
            entrypoint: 'RuntimeSmokeEntrypoint',
            props: {
              caller: 'ar-control',
              audience: 'authrim-runtime-smoke-v1',
              environmentId: 'dr-test',
              targetWorker: `dr-test-${target}`,
            },
          });
        }
      } else {
        expect(generated.services).toContainEqual({
          binding: 'SAML_DR_MUTATION_CONTROL',
          service: 'dr-test-ar-control',
          entrypoint: 'SamlDrMutationEntrypoint',
          props: {
            caller: component,
            audience: 'authrim-saml-dr-mutation-v1',
            environmentId: 'dr-test',
          },
        });
      }
    }
  );
});
