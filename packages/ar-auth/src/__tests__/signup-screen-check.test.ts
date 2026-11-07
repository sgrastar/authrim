import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  resolveSignUpScreen: vi.fn(),
  resolveEffectiveSettings: vi.fn(),
}));

vi.mock('../login-runtime-flow', () => ({ resolveSignUpScreen: mocks.resolveSignUpScreen }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveEffectiveSettings: mocks.resolveEffectiveSettings,
}));

const { checkSignUpScreen } = await import('../signup-screen-check');

function contextWith(headers: Record<string, string> = {}): Context<{ Bindings: Env }> {
  return {
    env: {},
    req: { header: (name: string) => headers[name] ?? headers[name.toLowerCase()] },
  } as unknown as Context<{ Bindings: Env }>;
}

const flowRequired = (on: boolean) =>
  mocks.resolveEffectiveSettings.mockResolvedValue({
    'authentication-methods.signup.flow_required': on,
  });

const screen = {
  fields: [
    { field: 'email', label: 'Email', required: true },
    { field: 'company', label: 'Company', required: true },
    { field: 'signup', block_type: 'auth_widget', auth_method: 'passkey' },
  ],
};

describe('checkSignUpScreen', () => {
  beforeEach(() => {
    mocks.resolveSignUpScreen.mockReset();
    mocks.resolveEffectiveSettings.mockReset();
    flowRequired(false);
  });

  it('leaves a sign-up that names no interaction to the Identity Schema, by default', async () => {
    await expect(
      checkSignUpScreen(contextWith(), 'tenant_1', { customFields: { anything: 'x' } })
    ).resolves.toEqual({ ok: true });
    expect(mocks.resolveSignUpScreen).not.toHaveBeenCalled();
  });

  it('refuses a sign-up that names no interaction where sign-ups go through a Flow', async () => {
    flowRequired(true);
    await expect(
      checkSignUpScreen(contextWith(), 'tenant_1', { customFields: {} })
    ).resolves.toEqual({ ok: false, reason: 'flow_required', field: null });
    expect(mocks.resolveEffectiveSettings).toHaveBeenCalledWith({}, 'authentication-methods', {
      tenantId: 'tenant_1',
    });
  });

  it('checks the attributes against the screen of the interaction in the header', async () => {
    mocks.resolveSignUpScreen.mockResolvedValue({ kind: 'screen', stepId: 's:step', screen });
    const c = contextWith({ 'X-Authrim-Interaction-Id': 'fi_1' });

    await expect(
      checkSignUpScreen(c, 'tenant_1', { customFields: { company: 'Acme' } })
    ).resolves.toEqual({ ok: true });
    expect(mocks.resolveSignUpScreen).toHaveBeenCalledWith(c, 'tenant_1', 'fi_1');

    await expect(
      checkSignUpScreen(c, 'tenant_1', { customFields: { company: 'Acme', role: 'admin' } })
    ).resolves.toEqual({ ok: false, reason: 'unknown_field', field: 'role' });
    await expect(checkSignUpScreen(c, 'tenant_1', { customFields: {} })).resolves.toEqual({
      ok: false,
      reason: 'required',
      field: 'company',
    });
    // The setting is not read when an interaction is named.
    expect(mocks.resolveEffectiveSettings).not.toHaveBeenCalled();
  });

  it('reads only the body for a route that names the interaction there', async () => {
    mocks.resolveSignUpScreen.mockResolvedValue({ kind: 'built_in' });
    const c = contextWith({ 'X-Authrim-Interaction-Id': 'fi_header' });

    await expect(
      checkSignUpScreen(c, 'tenant_1', { customFields: { x: 1 }, interactionId: 'fi_body' })
    ).resolves.toEqual({ ok: true });
    expect(mocks.resolveSignUpScreen).toHaveBeenCalledWith(c, 'tenant_1', 'fi_body');

    // A body that names none is a sign-up outside a Flow, whatever the header says.
    mocks.resolveSignUpScreen.mockClear();
    flowRequired(true);
    await expect(
      checkSignUpScreen(c, 'tenant_1', { customFields: {}, interactionId: null })
    ).resolves.toEqual({ ok: false, reason: 'flow_required', field: null });
    expect(mocks.resolveSignUpScreen).not.toHaveBeenCalled();
  });

  it('refuses an interaction that is not live, not a sign-up step, or not an id', async () => {
    const c = contextWith({ 'X-Authrim-Interaction-Id': 'fi_1' });
    mocks.resolveSignUpScreen.mockResolvedValueOnce({
      kind: 'invalid',
      reason: 'interaction_not_found',
    });
    await expect(checkSignUpScreen(c, 'tenant_1', { customFields: {} })).resolves.toEqual({
      ok: false,
      reason: 'interaction_not_found',
      field: null,
    });
    mocks.resolveSignUpScreen.mockResolvedValueOnce({
      kind: 'invalid',
      reason: 'not_a_sign_up_step',
    });
    await expect(checkSignUpScreen(c, 'tenant_1', { customFields: {} })).resolves.toMatchObject({
      reason: 'not_a_sign_up_step',
    });

    mocks.resolveSignUpScreen.mockClear();
    await expect(
      checkSignUpScreen(contextWith({ 'X-Authrim-Interaction-Id': 'fi 1/../x' }), 'tenant_1', {
        customFields: {},
      })
    ).resolves.toMatchObject({ reason: 'interaction_not_found' });
    expect(mocks.resolveSignUpScreen).not.toHaveBeenCalled();
  });
});
