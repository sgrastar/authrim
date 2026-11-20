import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../core';
import {
  projectAgentGrantListResponse,
  projectAgentSessionPostureResponse,
  projectAgentSettingsResponse,
} from '../platform/cloudflare/admin-read-routes';

const validWindow = {
  oldest_created_at: '2026-07-18T00:00:00.000Z',
  newest_last_accessed_at: null,
  next_expiration_at: '2026-07-21T00:00:00.000Z',
  latest_expiration_at: null,
};

function posture(snapshot: JsonObject): JsonValue {
  return { snapshot };
}

const validSnapshot = {
  total_sessions: 3,
  active_sessions: 2,
  expired_sessions: 1,
  window: validWindow,
};

describe('session posture projection', () => {
  it('accepts zero counts and null timestamps', () => {
    expect(
      projectAgentSessionPostureResponse(
        posture({
          total_sessions: 0,
          active_sessions: 0,
          expired_sessions: 0,
          window: {
            oldest_created_at: null,
            newest_last_accessed_at: null,
            next_expiration_at: null,
            latest_expiration_at: null,
          },
        })
      )
    ).toEqual({
      snapshot: {
        total_sessions: 0,
        active_sessions: 0,
        expired_sessions: 0,
        window: {
          oldest_created_at: null,
          newest_last_accessed_at: null,
          next_expiration_at: null,
          latest_expiration_at: null,
        },
      },
    });
  });

  it.each([
    ['non-object body', [validSnapshot]],
    ['array snapshot', { snapshot: [validSnapshot] }],
    [
      'negative total',
      posture({ ...validSnapshot, total_sessions: -1, active_sessions: -2, expired_sessions: 1 }),
    ],
    [
      'fractional active',
      posture({ ...validSnapshot, active_sessions: 1.5, expired_sessions: 1.5 }),
    ],
    ['string expired', posture({ ...validSnapshot, expired_sessions: '1' })],
    ['missing total', posture({ active_sessions: 2, expired_sessions: 1, window: validWindow })],
    ['array window', posture({ ...validSnapshot, window: [validWindow] })],
    [
      'non-ISO timestamp',
      posture({ ...validSnapshot, window: { ...validWindow, oldest_created_at: '2026-07-18' } }),
    ],
    [
      'unparseable timestamp',
      posture({
        ...validSnapshot,
        window: { ...validWindow, newest_last_accessed_at: 'not-a-date' },
      }),
    ],
    [
      'numeric timestamp',
      posture({ ...validSnapshot, window: { ...validWindow, next_expiration_at: 1 } }),
    ],
    [
      'missing timestamp',
      posture({
        ...validSnapshot,
        window: { ...validWindow, latest_expiration_at: undefined as unknown as null },
      }),
    ],
    [
      'oversized timestamp',
      posture({
        ...validSnapshot,
        window: { ...validWindow, oldest_created_at: `2026-07-18T00:00:00.000Z${' '.repeat(41)}` },
      }),
    ],
  ])('fails closed for %s', (_name, body) => {
    expect(() => projectAgentSessionPostureResponse(body)).toThrow(
      new TypeError('Invalid Agent session posture response')
    );
  });

  it('accepts an extended-year ISO timestamp', () => {
    // Extended-year ISO strings are the only valid ISO forms longer than 24 chars.
    const extended = '+275760-09-13T00:00:00.000Z';
    expect(new Date(extended).toISOString()).toBe(extended);
    expect(
      projectAgentSessionPostureResponse(
        posture({ ...validSnapshot, window: { ...validWindow, latest_expiration_at: extended } })
      )
    ).toMatchObject({ snapshot: { window: { latest_expiration_at: extended } } });
  });
});

describe('settings projection', () => {
  it('returns empty settings for every non-object settings shape', () => {
    for (const body of [
      [{ settings: { a: 1 } }],
      'text',
      { settings: null },
      { settings: 'x' },
      { settings: [1, 2] },
      {},
    ] as JsonValue[]) {
      expect(projectAgentSettingsResponse(body), JSON.stringify(body)).toEqual({ settings: {} });
    }
  });
});

const fullGrant = {
  id: 'grant-1',
  client_id: 'client-1',
  machine_principal_id: 'mp-1',
  purpose: 'Inspect configuration',
  status: 'active',
  delegation_mode: 'machine_policy',
  permissions: ['admin:users:read', 7, 'admin:clients:read'],
  scopes: ['agent:read'],
  task_set_id: 'task-set-1',
  task_set_version: 3,
  scope_policy_id: 'policy-1',
  scope_policy_version: 4,
  expires_at: 4_000,
  last_used_at: 3_000,
  created_at: 1_000,
  updated_at: 2_000,
};

describe('agent grant list projection', () => {
  it('projects every allowlisted grant field exactly', () => {
    expect(projectAgentGrantListResponse({ grants: [fullGrant] })).toEqual({
      grants: [
        {
          id: 'grant-1',
          client_id: 'client-1',
          machine_principal_id: 'mp-1',
          purpose: 'Inspect configuration',
          status: 'active',
          delegation_mode: 'machine_policy',
          permissions: ['admin:users:read', 'admin:clients:read'],
          scopes: ['agent:read'],
          task_set_id: 'task-set-1',
          task_set_version: 3,
          scope_policy_id: 'policy-1',
          scope_policy_version: 4,
          expires_at: 4_000,
          last_used_at: 3_000,
          created_at: 1_000,
          updated_at: 2_000,
        },
      ],
      pagination: { total: 1, limit: 1, offset: 0 },
    });
  });

  it('normalizes malformed optional fields to null/unknown/[] and truncates strings', () => {
    const projected = projectAgentGrantListResponse({
      grants: [
        {
          id: 'grant-2',
          client_id: `https://c.example/${'a'.repeat(3000)}`,
          machine_principal_id: 5,
          purpose: 'p'.repeat(600),
          status: 1,
          delegation_mode: null,
          permissions: 'admin:users:read',
          scopes: Array.from({ length: 300 }, (_, i) => `s${i}`),
          task_set_id: 1,
          task_set_version: 1.5,
          scope_policy_id: false,
          scope_policy_version: '4',
          expires_at: '4000',
          last_used_at: 1.1,
          created_at: null,
          updated_at: Number.MAX_SAFE_INTEGER + 2,
        },
      ],
    }) as { grants: Record<string, JsonValue>[] };
    const [grant] = projected.grants;
    expect(grant).toEqual({
      id: 'grant-2',
      client_id: `https://c.example/${'a'.repeat(3000)}`.slice(0, 2048),
      machine_principal_id: null,
      purpose: 'p'.repeat(500),
      status: 'unknown',
      delegation_mode: 'unknown',
      permissions: [],
      scopes: Array.from({ length: 256 }, (_, i) => `s${i}`),
      task_set_id: null,
      task_set_version: null,
      scope_policy_id: null,
      scope_policy_version: null,
      expires_at: null,
      last_used_at: null,
      created_at: null,
      updated_at: null,
    });
  });

  it('drops invalid grant entries, caps the list at 50 and honours pagination numbers', () => {
    const grants = [
      null,
      'grant',
      [fullGrant],
      { id: 1, client_id: 'c' },
      { id: 'g', client_id: 2 },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `g${i}`, client_id: 'c' })),
    ];
    const projected = projectAgentGrantListResponse({
      grants,
      pagination: { total: 0, limit: 0, offset: 7 },
    }) as { grants: { id: string }[]; pagination: JsonObject };
    // Five invalid entries consume part of the 50-entry window before filtering.
    expect(projected.grants.map((grant) => grant.id)).toEqual(
      Array.from({ length: 45 }, (_, i) => `g${i}`)
    );
    expect(projected.pagination).toEqual({ total: 0, limit: 0, offset: 7 });
  });

  it('falls back to the projected count when pagination numbers are invalid', () => {
    expect(
      projectAgentGrantListResponse({
        grants: [fullGrant, fullGrant],
        pagination: { total: -1, limit: '25', offset: 1.5 },
      })
    ).toMatchObject({ pagination: { total: 2, limit: 2, offset: 0 } });
    expect(projectAgentGrantListResponse(null)).toEqual({
      grants: [],
      pagination: { total: 0, limit: 0, offset: 0 },
    });
    expect(projectAgentGrantListResponse({ grants: 'x', pagination: [1] })).toEqual({
      grants: [],
      pagination: { total: 0, limit: 0, offset: 0 },
    });
  });
});
