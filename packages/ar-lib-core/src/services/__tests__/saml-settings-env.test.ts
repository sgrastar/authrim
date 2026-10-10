import { describe, expect, it } from 'vitest';
import { resolveSamlAssertionTtlSeconds, resolveSamlRequestTtlSeconds } from '../saml-settings';

/** These go through the real settings reader, so the environment variable is parsed as deployed. */
describe('SAML lifetimes from the environment', () => {
  it.each([
    ['SAML_REQUEST_TTL', resolveSamlRequestTtlSeconds],
    ['SAML_ASSERTION_TTL', resolveSamlAssertionTtlSeconds],
  ] as const)('%s is read whole and in range', async (name, resolve) => {
    await expect(resolve({ [name]: '120' } as never, 't')).resolves.toBe(120);
    for (const bad of ['600.9', '60junk', '59', '601', '1e2', '-5', 'abc']) {
      await expect(resolve({ [name]: bad } as never, 't'), bad).resolves.toBe(300);
    }
  });
});
