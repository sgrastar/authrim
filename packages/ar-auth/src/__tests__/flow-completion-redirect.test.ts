import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  registration: vi.fn(),
  tenantRegistration: vi.fn(),
  signIn: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    loadInteractionRegistrationPolicy: core.registration,
    loadTenantRegistrationPolicy: core.tenantRegistration,
    loadInteractionFlowProfileRefs: core.signIn,
    resolveRegistrationCompletionRedirectUrl: core.resolve,
  };
});

const { flowCompletionRedirect } = await import('../registration-policy-gate');

const context = { env: {}, req: { header: () => undefined } } as never;
const signIn = (overrides: Record<string, unknown> = {}) => ({
  methodProfileRef: 'default',
  sessionProfileRef: 'default',
  flowKind: 'login',
  completion: { behavior: 'service_site', service_site_path: '/portal' },
  live: true,
  ...overrides,
});

beforeEach(() => {
  core.registration.mockReset().mockResolvedValue(null);
  core.tenantRegistration.mockReset().mockResolvedValue(null);
  core.signIn.mockReset();
  core.resolve
    .mockReset()
    .mockImplementation(
      async (_env: unknown, _tenant: string, completion: { behavior: string }) => ({
        redirectUrl: `https://auth.example.com/${completion.behavior}`,
      })
    );
});

describe('where a Flow sends the person once a session is made', () => {
  it('follows a sign-in Flow’s own destination, checked as the tenant’s is', async () => {
    core.signIn.mockResolvedValue(signIn());
    expect(await flowCompletionRedirect(context, 'tenant-a', 'interaction-1')).toBe(
      'https://auth.example.com/service_site'
    );
    expect(core.resolve).toHaveBeenCalledWith({}, 'tenant-a', {
      behavior: 'service_site',
      service_site_path: '/portal',
    });
  });

  it('leaves it to the tenant for a sign-in Flow without one, or one no longer live', async () => {
    core.signIn.mockResolvedValue(signIn({ completion: null }));
    expect(await flowCompletionRedirect(context, 'tenant-a', 'interaction-1')).toBeNull();
    core.signIn.mockResolvedValue(signIn({ live: false }));
    expect(await flowCompletionRedirect(context, 'tenant-a', 'interaction-1')).toBeNull();
    core.signIn.mockResolvedValue(signIn({ flowKind: 'registration' }));
    expect(await flowCompletionRedirect(context, 'tenant-a', 'interaction-1')).toBeNull();
    expect(await flowCompletionRedirect(context, 'tenant-a', null)).toBeNull();
    expect(core.resolve).not.toHaveBeenCalled();
  });

  it('takes a registration interaction’s destination before looking further', async () => {
    core.registration.mockResolvedValue({
      policy: { completion: { behavior: 'account' } },
      profileRef: 'default',
      sessionProfileRef: 'default',
      flowId: 'f',
      flowVersionId: 'v',
      live: true,
    });
    expect(await flowCompletionRedirect(context, 'tenant-a', 'interaction-1')).toBe(
      'https://auth.example.com/account'
    );
    expect(core.signIn).not.toHaveBeenCalled();
  });
});
