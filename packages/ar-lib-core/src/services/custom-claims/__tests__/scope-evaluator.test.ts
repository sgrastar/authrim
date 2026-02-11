import { describe, it, expect } from 'vitest';
import { ClaimScopeEvaluator } from '../scope-evaluator';
import type { CustomClaimSchema } from '../resolver';

function makeSchema(overrides: Partial<CustomClaimSchema> = {}): CustomClaimSchema {
  return {
    id: 'test-id',
    tenant_id: 'default',
    field_key: 'test_field',
    display_label: 'Test',
    field_type: 'string',
    is_pii: 0,
    is_required: 0,
    is_active: 1,
    validation_rules: null,
    include_in_id_token: 0,
    include_in_userinfo: 0,
    include_in_introspection: 0,
    required_scopes: null,
    scope_mode: 'any',
    is_searchable: 1,
    is_exportable: 1,
    is_vc_claim: 0,
    claim_namespace: null,
    description: null,
    display_order: 0,
    schema_version: 1,
    operation_status: 'active',
    operation_detail: null,
    created_by: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('ClaimScopeEvaluator', () => {
  const evaluator = new ClaimScopeEvaluator();

  describe('no required_scopes', () => {
    it('includes when required_scopes is null', () => {
      const schema = makeSchema({ required_scopes: null });
      expect(evaluator.shouldInclude(schema, ['openid'], 'id_token')).toBe(true);
    });

    it('includes when required_scopes is empty array JSON', () => {
      const schema = makeSchema({ required_scopes: '[]' });
      expect(evaluator.shouldInclude(schema, [], 'id_token')).toBe(true);
    });
  });

  describe('scope_mode=any', () => {
    it('includes when at least one scope matches', () => {
      const schema = makeSchema({
        required_scopes: '["profile","email"]',
        scope_mode: 'any',
      });
      expect(evaluator.shouldInclude(schema, ['email'], 'id_token')).toBe(true);
    });

    it('excludes when no scope matches', () => {
      const schema = makeSchema({
        required_scopes: '["profile","email"]',
        scope_mode: 'any',
      });
      expect(evaluator.shouldInclude(schema, ['openid'], 'id_token')).toBe(false);
    });
  });

  describe('scope_mode=all', () => {
    it('includes when all scopes match', () => {
      const schema = makeSchema({
        required_scopes: '["profile","email"]',
        scope_mode: 'all',
      });
      expect(evaluator.shouldInclude(schema, ['openid', 'profile', 'email'], 'id_token')).toBe(
        true
      );
    });

    it('excludes when not all scopes match', () => {
      const schema = makeSchema({
        required_scopes: '["profile","email"]',
        scope_mode: 'all',
      });
      expect(evaluator.shouldInclude(schema, ['profile'], 'id_token')).toBe(false);
    });
  });

  describe('VC target', () => {
    it('always includes for VC target regardless of scopes', () => {
      const schema = makeSchema({
        required_scopes: '["admin"]',
        scope_mode: 'all',
      });
      expect(evaluator.shouldInclude(schema, [], 'vc')).toBe(true);
    });
  });

  describe('invalid required_scopes JSON', () => {
    it('includes when JSON is invalid', () => {
      const schema = makeSchema({ required_scopes: 'not-json' });
      expect(evaluator.shouldInclude(schema, [], 'id_token')).toBe(true);
    });
  });
});
