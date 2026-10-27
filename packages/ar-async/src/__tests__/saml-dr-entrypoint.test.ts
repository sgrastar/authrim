import { describe, expect, it, vi } from 'vitest';
import worker from '../index';

const request = () => new Request('https://issuer.example/__saml_dr_entrypoint_probe');
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

describe('SAML DR source guard on the installed fetch entrypoint', () => {
  it.each([undefined, 'false'])('does not acquire admission when the flag is %s', async (flag) => {
    const acquire = vi.fn();
    const response = await worker.fetch(
      request(),
      {
        ENABLE_SAML_DR_EXPORT: flag,
        SAML_DR_MUTATION_CONTROL: { acquireEnvironmentBackupMutationPermit: acquire },
        ENABLE_RATE_LIMIT: 'false',
        ISSUER_URL: 'https://issuer.example',
      } as never,
      context
    );
    expect(response.status).not.toBe(503);
    expect(acquire).not.toHaveBeenCalled();
  });
  it('fails closed before any handler when its configured admission binding is unavailable', async () => {
    const response = await worker.fetch(
      request(),
      { ENABLE_SAML_DR_EXPORT: 'true' } as never,
      context
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.text()).not.toContain('binding');
  });
  it('refuses a source write during an active freeze', async () => {
    const acquire = vi.fn(async () => ({ admitted: false }));
    const complete = vi.fn();
    const response = await worker.fetch(
      request(),
      {
        ENABLE_SAML_DR_EXPORT: 'true',
        SAML_DR_MUTATION_CONTROL: {
          acquireEnvironmentBackupMutationPermit: acquire,
          completeEnvironmentBackupMutationPermit: complete,
        },
      } as never,
      context
    );
    expect(response.status).toBe(503);
    expect(acquire).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
});
