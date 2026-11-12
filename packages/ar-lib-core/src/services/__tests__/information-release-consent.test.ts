import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INFORMATION_RELEASE_CONSENT,
  accountInformationRelease,
  applyReleaseApproval,
  automaticReleaseApproval,
  mergeReleaseCandidates,
  parseInformationReleaseConsentSetting,
  readInformationReleaseConsentSetting,
  releaseApprovalWithoutScreen,
  releaseCandidatesOf,
  releasePresentationKey,
  reusableReleaseApproval,
  type ReleaseConsentRecord,
} from '../information-release-consent';

const once = { ...DEFAULT_INFORMATION_RELEASE_CONSENT };
const candidates = [
  { name: 'email', required: false },
  { name: 'name', required: true },
];
const record = (overrides: Partial<ReleaseConsentRecord> = {}): ReleaseConsentRecord => ({
  presented: ['email', 'name'],
  approved: ['name'],
  declined: ['email'],
  mode: 'once',
  basis: 'user',
  decidedAt: 1,
  ...overrides,
});

describe('information release consent settings', () => {
  it('asks once, showing values, unless set otherwise', () => {
    expect(parseInformationReleaseConsentSetting(undefined)).toEqual({ ok: true, setting: once });
    expect(parseInformationReleaseConsentSetting({ ask: 'every_time' })).toEqual({
      ok: true,
      setting: { ...once, ask: 'every_time' },
    });
  });

  it('refuses an unknown key or a malformed value', () => {
    expect(parseInformationReleaseConsentSetting({ mode: 'once' }).ok).toBe(false);
    expect(parseInformationReleaseConsentSetting({ ask: 'sometimes' }).ok).toBe(false);
    expect(parseInformationReleaseConsentSetting({ enabled: 'yes' }).ok).toBe(false);
    expect(parseInformationReleaseConsentSetting({ purpose_statement_id: 'a b' }).ok).toBe(false);
  });

  it('reads a stored value that cannot be read as the default (never as not asked)', () => {
    expect(readInformationReleaseConsentSetting('not json')).toEqual(once);
    expect(readInformationReleaseConsentSetting('{"enabled":"no"}')).toEqual(once);
    expect(readInformationReleaseConsentSetting('{"enabled":false}').enabled).toBe(false);
  });
});

describe('release candidates', () => {
  it('takes the information about the person, required unless the service says optional', () => {
    expect(
      releaseCandidatesOf(
        { iss: 'x', sub: 'u', nonce: 'n', authrim_release: [], name: 'A', email: 'a@x' },
        new Set(['email'])
      )
    ).toEqual(candidates);
  });

  it('treats an item required by either the ID token or UserInfo as required', () => {
    expect(
      mergeReleaseCandidates(
        [{ name: 'email', required: false }],
        [{ name: 'email', required: true }]
      )
    ).toEqual([{ name: 'email', required: true }]);
  });

  it('keys what was shown by the items, their being required and the purpose version', async () => {
    const key = await releasePresentationKey(candidates, '20260101');
    expect(await releasePresentationKey([...candidates].reverse(), '20260101')).toBe(key);
    expect(await releasePresentationKey(candidates, '20260201')).not.toBe(key);
    expect(
      await releasePresentationKey(
        [
          { name: 'email', required: true },
          { name: 'name', required: true },
        ],
        '20260101'
      )
    ).not.toBe(key);
  });
});

describe('deciding without asking', () => {
  it('approves everything for a trusted service and the required items when not asking', () => {
    expect(automaticReleaseApproval(once, true)).toEqual({ basis: 'trust', approval: ['*'] });
    expect(automaticReleaseApproval({ ...once, enabled: false }, false)).toEqual({
      basis: 'not_asked',
      approval: ['@required'],
    });
    expect(automaticReleaseApproval(once, false)).toBeNull();
  });
});

describe('reusing the earlier decision', () => {
  it('reuses it while every required item was approved and every optional one answered', () => {
    expect(reusableReleaseApproval(once, record(), candidates)).toEqual(['name']);
  });

  it('asks again for an item added since, or one that became required', () => {
    expect(
      reusableReleaseApproval(once, record(), [
        ...candidates,
        { name: 'phone_number', required: false },
      ])
    ).toBeNull();
    expect(
      reusableReleaseApproval(once, record(), [
        { name: 'email', required: true },
        { name: 'name', required: true },
      ])
    ).toBeNull();
  });

  it('asks again when the items changed, for a service asking when they change', () => {
    const whenChanged = { ...once, ask: 'when_items_change' as const };
    expect(reusableReleaseApproval(whenChanged, record(), candidates)).toEqual(['name']);
    expect(
      reusableReleaseApproval(whenChanged, record(), [{ name: 'name', required: true }])
    ).toBeNull();
  });

  it('never reuses for a service asking every time, nor a decision made by trust', () => {
    expect(
      reusableReleaseApproval({ ...once, ask: 'every_time' }, record(), candidates)
    ).toBeNull();
    expect(reusableReleaseApproval(once, record({ basis: 'trust' }), candidates)).toBeNull();
    expect(reusableReleaseApproval(once, null, candidates)).toBeNull();
  });

  it('gives a grant without the screen the person’s approval unless asked every time', () => {
    expect(releaseApprovalWithoutScreen(once, record(), false)).toEqual(['name']);
    expect(
      releaseApprovalWithoutScreen({ ...once, ask: 'every_time' }, record(), false)
    ).toBeNull();
    expect(releaseApprovalWithoutScreen(once, null, false)).toBeNull();
    expect(releaseApprovalWithoutScreen(once, null, true)).toEqual(['*']);
  });
});

describe('holding claims to an approval', () => {
  const claims = { sub: 'u', aud: 'app', name: 'A', email: 'a@x' };

  it('leaves out an optional item that was not approved', () => {
    expect(applyReleaseApproval(claims, new Set(['email']), ['name'])).toEqual({
      ok: true,
      claims: { sub: 'u', aud: 'app', name: 'A' },
    });
  });

  it('stops at a required item that was not approved', () => {
    expect(applyReleaseApproval(claims, new Set(), ['name'])).toEqual({
      ok: false,
      missing: ['email'],
    });
  });

  it('holds an authrim_-prefixed claim a mapping made to the approval, but not server claims', () => {
    expect(
      applyReleaseApproval(
        { sub: 'u', ds_hash: 'h', authrim_roles: ['r'], authrim_employee_id: 'E1' },
        new Set(['authrim_employee_id']),
        []
      )
    ).toEqual({ ok: true, claims: { sub: 'u', ds_hash: 'h', authrim_roles: ['r'] } });
  });

  it('releases only protocol claims without an approval', () => {
    expect(applyReleaseApproval(claims, new Set(['name', 'email']), null)).toEqual({
      ok: true,
      claims: { sub: 'u', aud: 'app' },
    });
  });
});

describe('the decision as the account page shows it', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    release_approved_json: JSON.stringify(['email', 'name']),
    release_declined_json: JSON.stringify(['picture']),
    release_basis: 'user',
    release_decided_at: 5,
    ...overrides,
  });

  it("gives the person's approved and declined claims", () => {
    expect(accountInformationRelease(row())).toEqual({
      basis: 'user',
      approved: ['email', 'name'],
      declined: ['picture'],
      decidedAt: 5,
    });
  });

  it('names no claims when the decision was made for the person', () => {
    expect(
      accountInformationRelease(row({ release_basis: 'trust', release_approved_json: '["*"]' }))
    ).toEqual({ basis: 'trust', approved: [], declined: [], decidedAt: 5 });
    expect(
      accountInformationRelease(
        row({ release_basis: 'not_asked', release_approved_json: '["@required"]' })
      )
    ).toEqual({ basis: 'not_asked', approved: [], declined: [], decidedAt: 5 });
  });

  it("shows the service's current policy over the record, with PostgreSQL's string times", () => {
    expect(
      accountInformationRelease(
        row({ release_current_basis: 'trust', release_decided_at: '1777200000000' })
      )
    ).toEqual({ basis: 'trust', approved: [], declined: [], decidedAt: 1777200000000 });
    expect(
      accountInformationRelease(
        row({ release_current_basis: 'not_asked', release_decided_at: null, granted_at: '42' })
      )
    ).toEqual({ basis: 'not_asked', approved: [], declined: [], decidedAt: 42 });
    expect(accountInformationRelease(row({ release_decided_at: '5' }))?.decidedAt).toBe(5);
  });

  it("marks a policy's earlier decision superseded once the policy no longer decides", () => {
    const trustRecord = row({ release_basis: 'trust', release_approved_json: '["*"]' });
    expect(accountInformationRelease({ ...trustRecord, release_current_basis: null })).toEqual({
      basis: 'trust',
      approved: [],
      declined: [],
      decidedAt: 5,
      superseded: true,
    });
    // The person's own decision still counts.
    expect(accountInformationRelease(row({ release_current_basis: null }))?.basis).toBe('user');
  });

  it('is absent when nothing was decided or the record cannot be read', () => {
    expect(accountInformationRelease(row({ release_decided_at: null }))).toBeUndefined();
    expect(accountInformationRelease(row({ release_basis: 'other' }))).toBeUndefined();
    expect(accountInformationRelease({})).toBeUndefined();
    // A person's record whose items cannot be read is not shown as "nothing approved".
    for (const broken of ['{', 'null', '"email"', '[1]']) {
      expect(accountInformationRelease(row({ release_approved_json: broken }))).toBeUndefined();
      expect(accountInformationRelease(row({ release_declined_json: broken }))).toBeUndefined();
    }
    expect(accountInformationRelease(row({ release_decided_at: Number.NaN }))).toBeUndefined();
  });
});
