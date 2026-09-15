import { describe, expect, it } from 'vitest';
import type { PortableSqliteRow } from '../sqlite-dataset-inspector.js';
import {
  inspectPhase5SqliteReferences,
  phase5SqliteRestoreOverrides,
  phase5SqliteRestoreDependencies,
  phase5SqliteVerificationIgnoredColumns,
} from '../phase5-sqlite-references.js';

const identity = {
  module: 'flows-ui' as const,
  collection: 'core.flows',
  id: 'flow-a',
  tenantId: 'tenant-a',
};
const text = (value: string) => ['text', value] as const;
const nil = ['null', null] as const;

describe('Phase 5 SQL references', () => {
  it('retains published versions and screen references while validating runtime profiles', () => {
    const row: PortableSqliteRow = {
      published_version_id: text('version-a'),
      graph_definition: text(JSON.stringify({ nodes: [{ config: { screen_ref: 'login-a' } }] })),
      compiled_plan: text(JSON.stringify({ ui: { authentication_profile_ref: 'profile-a' } })),
      draft_editor_json: nil,
      draft_runtime_base_json: nil,
    };
    const references = inspectPhase5SqliteReferences('core.flows', row, identity);
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: expect.objectContaining({ collection: 'core.flow_versions' }),
        }),
        expect.objectContaining({ to: expect.objectContaining({ collection: 'core.screens' }) }),
      ])
    );
    expect(references.some(({ to }) => to.collection === 'core.profile_registry')).toBe(false);
  });

  it('maps every assignment target type to its installed dataset', () => {
    const cases = [
      ['oidc_client', 'client-a', 'core.oauth_clients'],
      ['saml_sp', 'saml-a', 'core.identity_providers'],
      ['credential_profile', 'credential-a', 'admin.credential_profiles'],
    ] as const;
    for (const [targetType, targetId, collection] of cases) {
      const refs = inspectPhase5SqliteReferences(
        'core.flow_assignments',
        { flow_id: text('flow-a'), target_type: text(targetType), target_id: text(targetId) },
        { ...identity, collection: 'core.flow_assignments' }
      );
      expect(refs.some((entry) => entry.to.collection === collection)).toBe(true);
    }
  });

  it('rejects malformed or unbounded embedded flow JSON', () => {
    expect(() =>
      inspectPhase5SqliteReferences(
        'core.flows',
        {
          published_version_id: nil,
          graph_definition: text('{'),
          compiled_plan: nil,
          draft_editor_json: nil,
          draft_runtime_base_json: nil,
        },
        identity
      )
    ).toThrow('backup_phase5_reference_invalid');
  });

  it('moves environment-encrypted fields through sidecar verification', () => {
    expect(phase5SqliteRestoreOverrides('core.webhook_configs')).toEqual({
      secret_encrypted: nil,
    });
    expect(phase5SqliteVerificationIgnoredColumns('core.webhook_configs')).toEqual([
      'secret_encrypted',
    ]);
    expect(phase5SqliteRestoreOverrides('admin.credential_secret_bodies')).toEqual({
      envelope_json: text('{}'),
    });
  });

  it('restores lookup retention before the tenant creation trigger installs its default', () => {
    expect(phase5SqliteRestoreDependencies('core.tenants')).toContain(
      'core.lookup_retention_policies'
    );
  });
});
