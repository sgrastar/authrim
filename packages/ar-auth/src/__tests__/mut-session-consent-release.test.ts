import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const m = vi.hoisted(() => ({
  getClientCached: vi.fn(),
  readSetting: vi.fn(),
  getLocalization: vi.fn(),
  queryOne: vi.fn(),
  findRecord: vi.fn(),
  compute: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getClientCached: m.getClientCached,
  readInformationReleaseConsentSetting: m.readSetting,
  getLocalization: m.getLocalization,
  findReleaseConsentRecord: m.findRecord,
  createAuthContextFromHono: () => ({ coreAdapter: { queryOne: m.queryOne } }),
  createAccountAuthContextFromHono: () => ({ coreAdapter: {} }),
}));
vi.mock('../release-candidates', () => ({ computeReleaseCandidates: m.compute }));

import {
  answerInformationRelease,
  loadInformationReleaseScreen,
  loadReleasePurpose,
} from '../consent-release';
import { RELEASE_APPROVE_REQUIRED, releasePresentationKey } from '@authrim/ar-lib-core';

const c = { env: {} } as unknown as Context<{ Bindings: Env }>;
const SETTING = { enabled: true, ask: 'always', show_values: false, purpose_statement_id: null };
const EMAIL = { name: 'email', required: false };
const NAME = { name: 'name', required: true };

function base(metadata: Record<string, unknown> = { scope: 'openid email' }) {
  return { c, tenantId: 't1', userId: 'u1', clientId: 'app', metadata: metadata as never };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getClientCached.mockResolvedValue({ client_id: 'app' });
  m.readSetting.mockReturnValue({ ...SETTING });
  m.compute.mockResolvedValue({ candidates: [NAME, EMAIL], values: { name: 'N', email: 'e@x' } });
  m.findRecord.mockResolvedValue(null);
});

describe('loadReleasePurpose', () => {
  it('reads nothing without a statement, or without a current version', async () => {
    expect(await loadReleasePurpose(c, 't1', null, 'en', 'en')).toBeUndefined();
    expect(m.queryOne).not.toHaveBeenCalled();
    m.queryOne.mockResolvedValueOnce(null);
    expect(await loadReleasePurpose(c, 't1', 'st-1', 'en', 'en')).toBeUndefined();
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining('is_current = 1'), [
      't1',
      'st-1',
    ]);
    expect(m.getLocalization).not.toHaveBeenCalled();
  });

  it('describes the current version in the asked language', async () => {
    m.queryOne.mockResolvedValue({ id: 'v-1', version: '20260101' });
    m.getLocalization.mockResolvedValueOnce({
      title: 'Why',
      description: 'Because',
      document_url: 'https://example.com/why',
      inline_content: '<p>why</p>',
    });
    expect(await loadReleasePurpose(c, 't1', 'st-1', 'ja', 'en')).toEqual({
      statement_id: 'st-1',
      version: '20260101',
      title: 'Why',
      description: 'Because',
      document_url: 'https://example.com/why',
      inline_content: '<p>why</p>',
    });
    expect(m.getLocalization).toHaveBeenCalledWith(expect.anything(), 't1', 'v-1', 'ja', 'en');
  });

  it('falls back to the statement id without a localization', async () => {
    m.queryOne.mockResolvedValue({ id: 'v-1', version: '20260101' });
    m.getLocalization.mockResolvedValueOnce(null);
    expect(await loadReleasePurpose(c, 't1', 'st-1', 'en', 'en')).toEqual({
      statement_id: 'st-1',
      version: '20260101',
      title: 'st-1',
      document_url: null,
      inline_content: null,
    });
  });
});

describe('loadInformationReleaseScreen', () => {
  const screen = (metadata?: Record<string, unknown>) =>
    loadInformationReleaseScreen({
      ...base(metadata),
      language: 'en',
      defaultLanguage: 'en',
      consentGeneration: 3,
    });

  it.each([
    ['id_token', true],
    ['id_token token', false],
    ['code id_token', false],
    ['code', false],
  ])('passes idTokenOnly for response_type %s', async (responseType, expected) => {
    await screen({ scope: 'openid', response_type: responseType });
    expect(m.compute).toHaveBeenCalledWith(expect.objectContaining({ idTokenOnly: expected }));
  });

  it('computes with no scopes when the request has none', async () => {
    await screen({});
    expect(m.compute).toHaveBeenCalledWith(expect.objectContaining({ scopes: [] }));
  });

  it('lists the items with earlier approvals and no purpose when none is configured', async () => {
    m.findRecord.mockResolvedValue({ basis: 'user', approved: ['email'] });
    const result = await screen();
    expect(result).toEqual({
      items: [
        { name: 'name', required: true },
        { name: 'email', required: false, previously_approved: true },
      ],
      show_values: false,
      presentation_key: await releasePresentationKey([NAME, EMAIL], null),
    });
    expect(m.findRecord).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 't1',
      userId: 'u1',
      clientId: 'app',
      consentGeneration: 3,
    });
  });
});

describe('answerInformationRelease', () => {
  const answer = async (extra: Record<string, unknown> = {}) =>
    answerInformationRelease({
      ...base(),
      effectiveScopes: ['openid', 'email'],
      selected: undefined,
      presentationKey: await releasePresentationKey([NAME, EMAIL], null),
      ...extra,
    });

  it('approves the required items and records not_asked when the setting is off', async () => {
    m.readSetting.mockReturnValue({ ...SETTING, enabled: false, ask: 'once' });
    expect(await answer()).toEqual({
      ok: true,
      approval: [RELEASE_APPROVE_REQUIRED],
      decision: { presented: [], approved: [], declined: [], mode: 'once', basis: 'not_asked' },
    });
  });

  it('keeps an empty user answer when there is nothing to release', async () => {
    m.compute.mockResolvedValue({ candidates: [], values: {} });
    expect(await answer()).toEqual({
      ok: true,
      approval: [],
      decision: { presented: [], approved: [], declined: [], mode: 'always', basis: 'user' },
    });
  });

  it('refuses an answer to a screen that has changed', async () => {
    expect(await answer({ presentationKey: 'stale' })).toEqual({ ok: false, reason: 'changed' });
  });

  it('approves required and selected items for the kept scopes', async () => {
    expect(await answer({ selected: ['email'] })).toMatchObject({
      approval: ['name', 'email'],
      decision: { presented: ['name', 'email'], approved: ['name', 'email'], declined: [] },
    });
  });

  it('approves nothing when the narrowed scopes can no longer be computed', async () => {
    m.getClientCached.mockResolvedValueOnce({ client_id: 'app' }).mockResolvedValueOnce(null);
    expect(await answer({ effectiveScopes: ['openid'] })).toEqual({
      ok: true,
      approval: [],
      decision: {
        presented: ['name', 'email'],
        approved: [],
        declined: [],
        mode: 'always',
        basis: 'user',
      },
    });
  });
});
