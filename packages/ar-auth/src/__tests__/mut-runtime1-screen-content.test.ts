/**
 * The screen a step shows, as resolveSignUpScreen resolves it: its default divider conditions,
 * the Identity Schema's requirements, its translation; and which visit a sign-up started on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  resolveSignUpScreen,
} from '../login-runtime-flow';
import { createContext, mocks, resetHarness } from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

const signIn = { field: 'signin', block_type: 'auth_widget', auth_method: 'passkey' };
const step = (id: string, component: string, screenRef?: string) => ({
  id,
  source_node_id: id.replace(':step', ''),
  component,
  config: screenRef ? { screen_ref: screenRef } : {},
});
const runtime = {
  flow_kind: 'login',
  ui: {
    steps: [
      step('login:step', 'authentication_method_selector', 'login'),
      step('signup:step', 'registration_method_selector', 'registration'),
      step('built-in:step', 'registration_method_selector'),
      step('code:step', 'email_verification', 'code_input'),
    ],
  },
};

interface ScreenRow {
  screen_kind?: string;
  fields: unknown[];
  localizations?: unknown;
  display_name?: string;
  description?: string | null;
}

interface Visit {
  stepId: string;
  createdAt: number;
  completedAtMs?: number;
}

function reads(input: {
  currentStepId: string;
  screens?: Record<string, ScreenRow>;
  context?: Record<string, unknown>;
  schemas?: Array<{ field_key: string; registration_required: number }>;
  visited?: Visit[];
  sameSecond?: Visit[];
  state?: string;
  expiresAt?: number;
}) {
  clearLoginRuntimeFlowVersionCacheForTests();
  mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = String(sql);
    if (text.includes('FROM flow_interactions')) {
      return {
        id: 'fi_1',
        flow_id: 'flow_1',
        flow_version_id: 'fv_1',
        user_id: null,
        client_id: null,
        saml_sp_id: null,
        state: input.state ?? 'active',
        current_node_id: input.currentStepId.replace(':step', ''),
        current_step_id: input.currentStepId,
        context_json: JSON.stringify(input.context ?? {}),
        contract_hash: 'hash',
        signature: 'sig',
        expires_at: input.expiresAt ?? Math.floor(Date.now() / 1000) + 600,
      };
    }
    if (text.includes('FROM flow_versions')) {
      return {
        id: 'fv_1',
        flow_id: 'flow_1',
        schema_version: 1,
        runtime_snapshot_json: JSON.stringify(runtime),
        editor_snapshot_json: null,
        published_at: 1,
      };
    }
    if (text.includes('FROM screens') && params[0] === 'tenant_1') {
      const ref = String(params[1]);
      const screen = (input.screens ?? {})[ref];
      return screen
        ? {
            id: `screen_${ref}`,
            screen_key: ref,
            display_name: screen.display_name ?? `Row ${ref}`,
            description: screen.description ?? null,
            screen_kind: screen.screen_kind ?? 'custom',
            fields_json: JSON.stringify(screen.fields),
            localizations_json:
              screen.localizations === undefined ? null : JSON.stringify(screen.localizations),
            settings_json: null,
          }
        : null;
    }
    return null;
  });
  const row = (visit: Visit) => ({
    step_id: visit.stepId,
    created_at: visit.createdAt,
    state_json:
      visit.completedAtMs === undefined
        ? null
        : JSON.stringify({ completed_at_ms: visit.completedAtMs }),
  });
  mocks.coreAdapter.query.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('SELECT field_key, registration_required')) return input.schemas ?? [];
    if (text.includes('AND created_at = ?')) return (input.sameSecond ?? []).map(row);
    if (text.includes('FROM flow_interaction_steps')) return (input.visited ?? []).map(row);
    return [];
  });
}

async function screenOf(input: Parameters<typeof reads>[0]) {
  reads(input);
  const resolved = await resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1');
  if (resolved.kind !== 'screen') throw new Error(`no screen: ${JSON.stringify(resolved)}`);
  return resolved.screen as { fields: Array<Record<string, unknown>> } & Record<string, unknown>;
}

beforeEach(() => resetHarness());
afterEach(() => vi.restoreAllMocks());

describe('the dividers of the login screen', () => {
  const dividers = [
    { field: 'divider.or', block_type: 'divider' },
    { field: 'divider.other_accounts', block_type: 'divider' },
    { field: 'divider.directory_password', block_type: 'divider' },
    { field: 'divider.custom', block_type: 'divider' },
    { field: 'divider.or', block_type: 'divider', display_condition: { mode: 'hidden' } },
    { field: 'divider.or', block_type: 'heading' },
    signIn,
  ];

  it('are shown only with the method each stands before, unless they say otherwise', async () => {
    const screen = await screenOf({
      currentStepId: 'login:step',
      screens: { login: { fields: dividers } },
    });
    expect(screen.fields.map((field) => field.display_condition ?? null)).toEqual([
      { mode: 'feature_enabled', feature: 'mail_otp' },
      { mode: 'feature_enabled', feature: 'external_idp' },
      { mode: 'feature_enabled', feature: 'directory_password' },
      null,
      { mode: 'hidden' },
      null,
      null,
    ]);
  });

  it('are left as they are on a screen other than login', async () => {
    const screen = await screenOf({
      currentStepId: 'signup:step',
      screens: { registration: { fields: dividers } },
    });
    expect(screen.fields.map((field) => field.display_condition ?? null)).toEqual([
      null,
      null,
      null,
      null,
      { mode: 'hidden' },
      null,
      null,
    ]);
  });
});

describe('the Identity Schema on a registration screen', () => {
  const fields = [
    { field: 'field.canonical.Company', label: 'Company' },
    { field: 'nickname', block_type: 'identity_field', required: true },
    { field: 'Nickname', block_type: 'checkbox', store_to_profile: false, required: true },
    { field: 'bio', block_type: 'heading' },
    { field: 'phone', label: 'Phone', required: true },
    { label: 'No field' },
    signIn,
  ];
  const schemas = [
    { field_key: 'Company', registration_required: 1 },
    { field_key: 'field.canonical.nickname', registration_required: 0 },
    { field_key: 'bio', registration_required: 1 },
  ];

  it('makes an attribute required as its schema says, and leaves the rest', async () => {
    const screen = await screenOf({
      currentStepId: 'signup:step',
      screens: { registration: { screen_kind: 'registration', fields } },
      schemas,
    });
    expect(screen.fields.map((field) => field.required)).toEqual([
      true,
      false,
      true,
      undefined,
      true,
      undefined,
      undefined,
    ]);
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM custom_claim_schemas'),
      ['tenant_1']
    );
  });

  it('requires an attribute when any of its schemas does', async () => {
    const screen = await screenOf({
      currentStepId: 'signup:step',
      screens: { registration: { screen_kind: 'registration', fields } },
      schemas: [
        { field_key: 'nickname', registration_required: 1 },
        { field_key: 'NICKNAME', registration_required: 0 },
      ],
    });
    expect(screen.fields[1].required).toBe(true);
  });

  it('is not read for a screen that is not a registration', async () => {
    const screen = await screenOf({
      currentStepId: 'signup:step',
      screens: { registration: { fields } },
      schemas,
    });
    expect(screen.fields[0].required).toBeUndefined();
  });
});

describe('the translation of a screen', () => {
  const fields = [
    { field: 'company', label: 'Company', placeholder: 'Acme' },
    { field: 'notice', block_type: 'text', text: 'Hello', block_id: 'blk_notice' },
    { field: 'phone', label: 'Phone', help_text: 'Mobile' },
    signIn,
  ];
  const localizations = {
    de: ['not an object'],
    ja: {
      display_name: ' 登録 ',
      description: '  ',
      fields: {
        'company-0': { label: ' 会社 ', placeholder: '', help_text: 7 },
        blk_notice: { text: 'こんにちは' },
        'notice-1': { text: 'not by position when it has a block id' },
        'phone-2': 'not an object',
      },
    },
    en: {
      display_name: 'Sign up',
      description: 'English',
      fields: { 'phone-2': { help_text: 'Cell' } },
    },
  };
  const screens = (localized: unknown) => ({
    registration: {
      fields,
      localizations: localized,
      display_name: 'Row name',
      description: 'Row description',
    },
  });

  it('shows the parts in the language of the request', async () => {
    const screen = await screenOf({
      currentStepId: 'signup:step',
      screens: screens(localizations),
      context: { locale: 'ja' },
    });
    expect(screen.display_name).toBe('登録');
    expect(screen.description).toBe('Row description');
    expect(screen.fields.slice(0, 3)).toEqual([
      { field: 'company', label: '会社', placeholder: 'Acme' },
      { field: 'notice', block_type: 'text', text: 'こんにちは', block_id: 'blk_notice' },
      { field: 'phone', label: 'Phone', help_text: 'Mobile' },
    ]);
  });

  it('falls back to English for another language, and English without a locale', async () => {
    for (const context of [{ locale: 'fr' }, {}]) {
      const screen = await screenOf({
        currentStepId: 'signup:step',
        screens: screens(localizations),
        context,
      });
      expect(screen).toMatchObject({ display_name: 'Sign up', description: 'English' });
      expect(screen.fields[2]).toEqual({ field: 'phone', label: 'Phone', help_text: 'Cell' });
    }
  });

  it('falls back to the first translation there is, and to the row without one', async () => {
    const first = await screenOf({
      currentStepId: 'signup:step',
      screens: screens({ de: [], fr: { display_name: 'Inscription', fields: [] } }),
      context: { locale: 'ja' },
    });
    expect(first.display_name).toBe('Inscription');
    expect(first.fields[0]).toEqual(fields[0]);

    const none = await screenOf({ currentStepId: 'signup:step', screens: screens(undefined) });
    expect(none).toMatchObject({ display_name: 'Row name', description: 'Row description' });
  });
});

describe('the visit a sign-up started on', () => {
  const screens = { registration: { fields: [signIn] } };

  it('reads the interaction and its visits for the tenant', async () => {
    reads({ currentStepId: 'signup:step', screens });
    await resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1');
    expect(mocks.coreAdapter.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM flow_interactions'),
      ['tenant_1', 'fi_1']
    );
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 20'), [
      'tenant_1',
      'fi_1',
    ]);
  });

  it('is taken from an interaction that is created but not yet active', async () => {
    reads({ currentStepId: 'signup:step', screens, state: 'created' });
    await expect(resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1')).resolves.toMatchObject(
      { kind: 'screen', stepId: 'signup:step' }
    );
  });

  it('is not taken from an interaction that expires this second', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    reads({ currentStepId: 'signup:step', screens, expiresAt: 1_800_000_000 });
    await expect(resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1')).resolves.toEqual({
      kind: 'invalid',
      reason: 'interaction_not_found',
    });
  });

  it('orders a visit of whole seconds against one kept to the millisecond', async () => {
    reads({
      currentStepId: 'code:step',
      screens,
      visited: [
        { stepId: 'built-in:step', createdAt: 99, completedAtMs: 99_500 },
        { stepId: 'signup:step', createdAt: 100 },
      ],
    });
    await expect(resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1')).resolves.toMatchObject(
      { kind: 'screen', stepId: 'signup:step' }
    );
  });

  it('keeps the later visits when it reads the whole second at the edge again', async () => {
    const edge = Array.from({ length: 19 }, (_, index) => ({
      stepId: 'code:step',
      createdAt: 100,
      completedAtMs: 100_000 + index,
    }));
    reads({
      currentStepId: 'code:step',
      screens,
      visited: [{ stepId: 'signup:step', createdAt: 200 }, ...edge],
      sameSecond: [...edge, { stepId: 'built-in:step', createdAt: 100, completedAtMs: 100_500 }],
    });
    await expect(resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1')).resolves.toMatchObject(
      { kind: 'screen', stepId: 'signup:step' }
    );
    expect(mocks.coreAdapter.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT 201'), [
      'tenant_1',
      'fi_1',
      100,
    ]);
  });

  it('skips a visited step the published Flow no longer has', async () => {
    reads({
      currentStepId: 'gone:step',
      screens,
      visited: [{ stepId: 'signup:step', createdAt: 100 }],
    });
    await expect(resolveSignUpScreen(createContext({}), 'tenant_1', 'fi_1')).resolves.toMatchObject(
      { kind: 'screen', stepId: 'signup:step' }
    );
  });
});
