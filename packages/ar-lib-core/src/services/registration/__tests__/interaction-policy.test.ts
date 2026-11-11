import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import {
  loadInteractionRegistrationPolicy,
  loadTenantRegistrationPolicy,
} from '../interaction-policy';

const runtime = (policy: Record<string, unknown>) =>
  JSON.stringify({
    ui: {
      steps: [
        {
          id: 'registration:step',
          component: 'registration_method_selector',
          config: { registration_policy: policy, authentication_profile_ref: 'members' },
        },
      ],
    },
  });

/** A database whose published version holds `snapshot` (an interaction's, and the tenant's). */
function dbWith(snapshot: string | null): DatabaseAdapter {
  return {
    queryOne: async (sql: string) => {
      if (sql.includes('FROM flow_interactions')) {
        return {
          flow_id: 'flow-1',
          flow_version_id: 'v1',
          state: 'active',
          expires_at: Math.floor(Date.now() / 1000) + 600,
        };
      }
      if (sql.includes('FROM flow_assignments')) return { runtime_snapshot_json: snapshot };
      return { runtime_snapshot_json: snapshot, kind: 'registration' };
    },
  } as unknown as DatabaseAdapter;
}

describe('a registration Flow’s policy, as a sign-up reads it', () => {
  it('reads the policy and profile of the published version', async () => {
    const db = dbWith(runtime({ eligibility: 'invite' }));
    await expect(loadInteractionRegistrationPolicy(db, 't1', 'i1')).resolves.toMatchObject({
      policy: { eligibility: 'invite' },
      profileRef: 'members',
      live: true,
    });
    await expect(loadTenantRegistrationPolicy(db, 't1')).resolves.toMatchObject({
      policy: { eligibility: 'invite' },
      profileRef: 'members',
    });
  });

  it('is no Flow when the version has no runtime (the tenant’s own then)', async () => {
    for (const empty of [null, '']) {
      await expect(loadInteractionRegistrationPolicy(dbWith(empty), 't1', 'i1')).resolves.toBe(
        null
      );
      await expect(loadTenantRegistrationPolicy(dbWith(empty), 't1')).resolves.toBeNull();
    }
  });

  it.each(['{not json', 'null', '{}', '{"ui":{"steps":{}}}', '[]'])(
    'refuses a runtime it cannot read as one (%s), rather than taking no limits',
    async (broken) => {
      await expect(loadInteractionRegistrationPolicy(dbWith(broken), 't1', 'i1')).rejects.toThrow(
        'registration_flow_runtime_unreadable'
      );
      await expect(loadTenantRegistrationPolicy(dbWith(broken), 't1')).rejects.toThrow(
        'registration_flow_runtime_unreadable'
      );
    }
  );
});
