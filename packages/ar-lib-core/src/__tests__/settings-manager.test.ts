/**
 * SettingsManager Unit Tests
 *
 * Test cases:
 * 1. ifMatch conflict → 409 Conflict
 * 2. Invalid key rejection → validation error
 * 3. Out of range values → validation error
 * 4. Type mismatch → validation error
 * 5. env override → rejected in response
 * 6. dependsOn validation
 * 7. Audit logging
 * 8. DISABLED_MARKER functionality
 * 9. Version hash generation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSettingsManager,
  SettingsManager,
  ConflictError,
  DISABLED_MARKER,
  isDisabled,
  generateVersion,
  type CategoryMeta,
  type SettingMeta,
  type SettingsAuditEvent,
} from '../utils/settings-manager';
import { OAUTH_CATEGORY_META } from '../types/settings/oauth';

// Test category metadata
const TEST_CATEGORY_META: CategoryMeta = {
  category: 'test',
  label: 'Test Settings',
  description: 'Test category for unit tests',
  settings: {
    'test.string_setting': {
      key: 'test.string_setting',
      type: 'string',
      default: 'default_value',
      envKey: 'TEST_STRING_SETTING',
      label: 'String Setting',
      description: 'A test string setting',
      visibility: 'public',
    } as SettingMeta,
    'test.number_setting': {
      key: 'test.number_setting',
      type: 'number',
      default: 100,
      envKey: 'TEST_NUMBER_SETTING',
      label: 'Number Setting',
      description: 'A test number setting',
      min: 10,
      max: 1000,
      visibility: 'public',
    } as SettingMeta,
    'test.boolean_setting': {
      key: 'test.boolean_setting',
      type: 'boolean',
      default: true,
      envKey: 'TEST_BOOLEAN_SETTING',
      label: 'Boolean Setting',
      description: 'A test boolean setting',
      visibility: 'public',
    } as SettingMeta,
    'test.duration_setting': {
      key: 'test.duration_setting',
      type: 'duration',
      default: 3600,
      envKey: 'TEST_DURATION_SETTING',
      label: 'Duration Setting',
      description: 'A test duration setting',
      min: 60,
      max: 86400,
      unit: 'seconds',
      visibility: 'public',
    } as SettingMeta,
    'test.enum_setting': {
      key: 'test.enum_setting',
      type: 'enum',
      default: 'option1',
      envKey: 'TEST_ENUM_SETTING',
      label: 'Enum Setting',
      description: 'A test enum setting',
      enum: ['option1', 'option2', 'option3'],
      visibility: 'public',
    } as SettingMeta,
    'test.json_setting': {
      key: 'test.json_setting',
      type: 'json',
      default: [],
      envKey: 'TEST_JSON_SETTING',
      label: 'JSON Setting',
      description: 'A test JSON setting',
      visibility: 'public',
    } as SettingMeta,
    'test.dependent_setting': {
      key: 'test.dependent_setting',
      type: 'boolean',
      default: false,
      envKey: 'TEST_DEPENDENT_SETTING',
      label: 'Dependent Setting',
      description: 'A setting that depends on another',
      visibility: 'public',
      dependsOn: [{ key: 'test.boolean_setting', value: true }],
    } as SettingMeta,
  },
};

// Mock KV namespace
function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(data));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

describe('SettingsManager', () => {
  let manager: SettingsManager;
  let mockKV: KVNamespace;
  let auditEvents: SettingsAuditEvent[];

  beforeEach(() => {
    auditEvents = [];
    mockKV = createMockKV();
    manager = createSettingsManager({
      env: {},
      kv: mockKV,
      cacheTTL: 0, // Disable caching for tests
      auditCallback: async (event) => {
        auditEvents.push(event);
      },
    });
    manager.registerCategory(TEST_CATEGORY_META);
  });

  describe('getAll', () => {
    it('should return default values when KV is empty', async () => {
      const result = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      expect(result.category).toBe('test');
      expect(result.values['test.string_setting']).toBe('default_value');
      expect(result.values['test.number_setting']).toBe(100);
      expect(result.values['test.boolean_setting']).toBe(true);
      expect(result.sources['test.string_setting']).toBe('default');
    });

    it('should prioritize KV over env over default (per CLAUDE.md)', async () => {
      // Set up KV value - use correct key format: settings:tenant:${id}:${category}
      mockKV = createMockKV({
        'settings:tenant:tenant_1:test': JSON.stringify({
          'test.string_setting': 'kv_value',
          'test.number_setting': 200,
        }),
      });

      // Set up env value
      manager = createSettingsManager({
        env: { TEST_STRING_SETTING: 'env_value' },
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const result = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      // KV > env > default (per CLAUDE.md: Priority: Cache → KV → Env → Default)
      // KV is set, so KV value takes priority over env
      expect(result.values['test.string_setting']).toBe('kv_value');
      expect(result.sources['test.string_setting']).toBe('kv');
      expect(result.values['test.number_setting']).toBe(200);
      expect(result.sources['test.number_setting']).toBe('kv');
      // No KV for boolean, and no env, so default is used
      expect(result.values['test.boolean_setting']).toBe(true);
      expect(result.sources['test.boolean_setting']).toBe('default');
    });

    it('should use env when KV is not set', async () => {
      // No KV value for string_setting
      mockKV = createMockKV({
        'settings:tenant:tenant_1:test': JSON.stringify({
          'test.number_setting': 200,
        }),
      });

      // Set up env value
      manager = createSettingsManager({
        env: { TEST_STRING_SETTING: 'env_value' },
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const result = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      // No KV for string_setting, so env value is used
      expect(result.values['test.string_setting']).toBe('env_value');
      expect(result.sources['test.string_setting']).toBe('env');
      // KV is set for number_setting
      expect(result.values['test.number_setting']).toBe(200);
      expect(result.sources['test.number_setting']).toBe('kv');
    });

    it('should parse JSON settings from env', async () => {
      manager = createSettingsManager({
        env: { TEST_JSON_SETTING: '[{"id":"passkey","enabled":true}]' },
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const result = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      expect(result.values['test.json_setting']).toEqual([{ id: 'passkey', enabled: true }]);
      expect(result.sources['test.json_setting']).toBe('env');
    });

    it('should handle DISABLED_MARKER correctly', async () => {
      // DISABLED_MARKER is resolved to false at runtime
      mockKV = createMockKV({
        'settings:tenant:tenant_1:test': JSON.stringify({
          'test.boolean_setting': DISABLED_MARKER,
        }),
      });

      manager = createSettingsManager({
        env: {},
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const result = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      // DISABLED_MARKER resolves to false at runtime (for boolean settings)
      expect(result.values['test.boolean_setting']).toBe(false);
      expect(result.sources['test.boolean_setting']).toBe('kv');
    });

    it('should throw error for unknown category', async () => {
      await expect(manager.getAll('unknown', { type: 'tenant', id: 'tenant_1' })).rejects.toThrow(
        'Unknown category'
      );
    });
  });

  describe('patch', () => {
    it('should apply valid settings', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const patchResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: {
            'test.string_setting': 'new_value',
            'test.number_setting': 500,
          },
        },
        'test_actor'
      );

      expect(patchResult.applied).toContain('test.string_setting');
      expect(patchResult.applied).toContain('test.number_setting');
      expect(patchResult.rejected).toEqual({});
    });

    it('should allow KV override when env is set (KV takes priority per CLAUDE.md)', async () => {
      // Per CLAUDE.md: Priority is Cache → KV → Environment variables → Default values
      // So KV writes should be allowed even when env is set
      manager = createSettingsManager({
        env: { TEST_STRING_SETTING: 'env_value' },
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const patchResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: {
            'test.string_setting': 'new_value',
          },
        },
        'test_actor'
      );

      // KV write should be allowed, not rejected
      expect(patchResult.applied).toContain('test.string_setting');
      expect(patchResult.rejected).toEqual({});

      // After KV write, the KV value should take priority over env
      const afterPatch = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      expect(afterPatch.values['test.string_setting']).toBe('new_value');
      expect(afterPatch.sources['test.string_setting']).toBe('kv');
    });

    it('should throw ConflictError on version mismatch', async () => {
      await expect(
        manager.patch(
          'test',
          { type: 'tenant', id: 'tenant_1' },
          {
            ifMatch: 'invalid_version',
            set: { 'test.string_setting': 'new_value' },
          },
          'test_actor'
        )
      ).rejects.toThrow(ConflictError);
    });

    it('should reject unknown keys', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const patchResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: {
            'test.unknown_key': 'value',
          },
        },
        'test_actor'
      );

      expect(patchResult.rejected['test.unknown_key']).toContain('Unknown setting');
    });

    it('should handle clear operation', async () => {
      // First set a value
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: { 'test.string_setting': 'custom_value' },
        },
        'test_actor'
      );

      // Then clear it
      const afterSetResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      const clearResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: afterSetResult.version,
          clear: ['test.string_setting'],
        },
        'test_actor'
      );

      expect(clearResult.cleared).toContain('test.string_setting');

      // Value should fall back to default
      const finalResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      expect(finalResult.values['test.string_setting']).toBe('default_value');
      expect(finalResult.sources['test.string_setting']).toBe('default');
    });

    it('should handle disable operation', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const disableResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          disable: ['test.boolean_setting'],
        },
        'test_actor'
      );

      expect(disableResult.disabled).toContain('test.boolean_setting');

      // After disable, the value resolves to false
      const afterDisable = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      expect(afterDisable.values['test.boolean_setting']).toBe(false);
      expect(afterDisable.sources['test.boolean_setting']).toBe('kv');
    });

    it('should reject disable on non-boolean settings', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const disableResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          disable: ['test.string_setting'],
        },
        'test_actor'
      );

      expect(disableResult.rejected['test.string_setting']).toContain('Only boolean settings');
    });
  });

  describe('validate', () => {
    it('should reject out of range number values', async () => {
      const result = manager.validate('test', {
        'test.number_setting': 5000, // max is 1000
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      const error = result.errors.find((e) => e.key === 'test.number_setting');
      expect(error?.reason).toContain('<=');
    });

    it('should reject values below minimum', async () => {
      const result = manager.validate('test', {
        'test.number_setting': 5, // min is 10
      });

      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.key === 'test.number_setting');
      expect(error?.reason).toContain('>=');
    });

    it('should reject type mismatches', async () => {
      const result = manager.validate('test', {
        'test.boolean_setting': 'not_a_boolean' as unknown as boolean,
      });

      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.key === 'test.boolean_setting');
      expect(error?.reason).toContain('boolean');
    });

    it('should validate JSON settings', async () => {
      expect(
        manager.validate('test', {
          'test.json_setting': '[{"id":"email_otp","login":true}]',
        }).valid
      ).toBe(true);

      expect(
        manager.validate('test', {
          'test.json_setting': [{ id: 'passkey', signup: true }],
        }).valid
      ).toBe(true);

      const result = manager.validate('test', {
        'test.json_setting': '[invalid-json',
      });

      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.key === 'test.json_setting');
      expect(error?.reason).toContain('valid JSON');
    });

    it('should reject invalid enum values', async () => {
      const result = manager.validate('test', {
        'test.enum_setting': 'invalid_option',
      });

      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.key === 'test.enum_setting');
      expect(error?.reason).toContain('must be one of');
    });

    it('should accept valid values', async () => {
      const result = manager.validate('test', {
        'test.string_setting': 'valid_string',
        'test.number_setting': 500,
        'test.boolean_setting': true,
        'test.enum_setting': 'option2',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('dependsOn validation in patch', () => {
    it('should reject settings with unsatisfied dependencies', async () => {
      // First, set the dependency to false
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: { 'test.boolean_setting': false },
        },
        'test_actor'
      );

      // Try to enable the dependent setting
      const afterSetResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      const patchResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: afterSetResult.version,
          set: { 'test.dependent_setting': true },
        },
        'test_actor'
      );

      expect(patchResult.rejected['test.dependent_setting']).toContain('Depends on');
    });

    it('should allow settings when dependencies are satisfied in same request', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      const patchResult = await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: {
            'test.boolean_setting': true,
            'test.dependent_setting': true,
          },
        },
        'test_actor'
      );

      expect(patchResult.applied).toContain('test.boolean_setting');
      expect(patchResult.applied).toContain('test.dependent_setting');
    });

    function managerWithDocs(docs: Record<string, Record<string, unknown>>, env = {}) {
      const kv = createMockKV(
        Object.fromEntries(Object.entries(docs).map(([key, value]) => [key, JSON.stringify(value)]))
      );
      const m = createSettingsManager({ env, kv, cacheTTL: 0 });
      m.registerCategory(TEST_CATEGORY_META);
      return m;
    }

    it('accepts a dependency met by the default when nothing is stored', async () => {
      const m = managerWithDocs({});
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const current = await m.getAll('test', scope);

      const result = await m.patch(
        'test',
        scope,
        { ifMatch: current.version, set: { 'test.dependent_setting': true } },
        'test_actor'
      );

      expect(result.applied).toContain('test.dependent_setting');
    });

    it('checks a dependency against the value inherited from a parent scope', async () => {
      const client = { type: 'client' as const, id: 'client_1', tenantId: 'tenant_1' };
      const parents = [{ type: 'tenant' as const, id: 'tenant_1' }];
      const blocked = managerWithDocs({
        'settings:tenant:tenant_1:test': { 'test.boolean_setting': false },
      });
      const current = await blocked.getAll('test', client, { parents });
      const refused = await blocked.patch(
        'test',
        client,
        { ifMatch: current.version, set: { 'test.dependent_setting': true } },
        'test_actor',
        { parents }
      );
      expect(refused.rejected['test.dependent_setting']).toContain('Depends on');

      const allowed = managerWithDocs(
        { 'settings:tenant:tenant_1:test': { 'test.boolean_setting': true } },
        { TEST_BOOLEAN_SETTING: 'false' }
      );
      const next = await allowed.getAll('test', client, { parents });
      const accepted = await allowed.patch(
        'test',
        client,
        { ifMatch: next.version, set: { 'test.dependent_setting': true } },
        'test_actor',
        { parents }
      );
      expect(accepted.applied).toContain('test.dependent_setting');
    });

    it('checks dependencies against a clear or disable in the same request', async () => {
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const disabling = managerWithDocs({
        'settings:tenant:tenant_1:test': { 'test.boolean_setting': true },
      });
      const before = await disabling.getAll('test', scope);
      const refused = await disabling.patch(
        'test',
        scope,
        {
          ifMatch: before.version,
          set: { 'test.dependent_setting': true },
          disable: ['test.boolean_setting'],
        },
        'test_actor'
      );
      expect(refused.rejected['test.dependent_setting']).toContain('currently disabled');
      expect(refused.disabled).toEqual(['test.boolean_setting']);

      const parents = [{ type: 'platform' as const }];
      const clearing = managerWithDocs({
        'settings:platform:test': { 'test.boolean_setting': true },
        'settings:tenant:tenant_1:test': { 'test.boolean_setting': false },
      });
      const current = await clearing.getAll('test', scope, { parents });
      const accepted = await clearing.patch(
        'test',
        scope,
        {
          ifMatch: current.version,
          set: { 'test.dependent_setting': true },
          clear: ['test.boolean_setting'],
        },
        'test_actor',
        { parents }
      );
      expect(accepted.rejected).toEqual({});
      expect(accepted.applied).toEqual(['test.dependent_setting']);
      expect(accepted.cleared).toEqual(['test.boolean_setting']);
    });

    it('refuses a key named by more than one operation', async () => {
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const m = managerWithDocs({
        'settings:tenant:tenant_1:test': { 'test.boolean_setting': true },
      });
      const current = await m.getAll('test', scope);

      const result = await m.patch(
        'test',
        scope,
        {
          ifMatch: current.version,
          set: { 'test.boolean_setting': false, 'test.number_setting': 200 },
          disable: ['test.boolean_setting'],
          clear: ['test.number_setting', 'test.string_setting'],
        },
        'test_actor'
      );

      expect(result.rejected['test.boolean_setting']).toContain('Conflicting');
      expect(result.rejected['test.number_setting']).toContain('Conflicting');
      expect(result.applied).toEqual([]);
      expect(result.disabled).toEqual([]);
      expect(result.cleared).toEqual([]);
      const after = await m.getAll('test', scope);
      expect(after.values['test.boolean_setting']).toBe(true);
    });

    it('records the inherited value as the result of a clear', async () => {
      const client = { type: 'client' as const, id: 'client_1', tenantId: 'tenant_1' };
      const parents = [{ type: 'tenant' as const, id: 'tenant_1' }];
      const events: SettingsAuditEvent[] = [];
      const kv = createMockKV({
        'settings:tenant:tenant_1:test': JSON.stringify({ 'test.number_setting': 200 }),
        'settings:client:tenant_1:client_1:test': JSON.stringify({ 'test.number_setting': 50 }),
      });
      const m = createSettingsManager({
        env: {},
        kv,
        cacheTTL: 0,
        auditCallback: async (event) => void events.push(event),
      });
      m.registerCategory(TEST_CATEGORY_META);
      const current = await m.getAll('test', client, { parents });

      await m.patch(
        'test',
        client,
        { ifMatch: current.version, clear: ['test.number_setting'] },
        'test_actor',
        { parents }
      );

      expect(events[0].diff['test.number_setting']).toEqual({ before: 50, after: 200 });
    });

    it('reports a dependency disabled in a parent scope as disabled', async () => {
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const parents = [{ type: 'platform' as const }];
      const m = managerWithDocs({
        'settings:platform:test': { 'test.boolean_setting': DISABLED_MARKER },
      });
      const current = await m.getAll('test', scope, { parents });

      const result = await m.patch(
        'test',
        scope,
        { ifMatch: current.version, set: { 'test.dependent_setting': true } },
        'test_actor',
        { parents }
      );

      expect(result.rejected['test.dependent_setting']).toContain('currently disabled');
    });
  });

  describe('settings narrowed to fewer scopes than their category', () => {
    const PLATFORM_ONLY: CategoryMeta = {
      ...TEST_CATEGORY_META,
      settings: {
        ...TEST_CATEGORY_META.settings,
        'test.number_setting': {
          ...TEST_CATEGORY_META.settings['test.number_setting'],
          scopes: ['platform'],
        } as SettingMeta,
      },
    };

    it('ignores a value stored at a scope the setting does not allow, and refuses to set it', async () => {
      const kv = createMockKV({
        'settings:platform:test': JSON.stringify({ 'test.number_setting': 300 }),
        'settings:tenant:tenant_1:test': JSON.stringify({ 'test.number_setting': 50 }),
      });
      const m = createSettingsManager({ env: {}, kv, cacheTTL: 0 });
      m.registerCategory(PLATFORM_ONLY);
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const parents = [{ type: 'platform' as const }];

      const current = await m.getAll('test', scope, { parents });
      expect(current.values['test.number_setting']).toBe(300);
      expect(current.sources['test.number_setting']).toBe('platform');

      const result = await m.patch(
        'test',
        scope,
        { ifMatch: current.version, set: { 'test.number_setting': 200 } },
        'test_actor',
        { parents }
      );
      expect(result.rejected['test.number_setting']).toContain('Not settable at tenant scope');
      expect(result.applied).toEqual([]);
    });
  });

  describe('runtime lifetimes', () => {
    it('refuses a fractional lifetime, which runtime could not apply', async () => {
      const m = createSettingsManager({ env: {}, kv: createMockKV(), cacheTTL: 0 });
      m.registerCategory(OAUTH_CATEGORY_META);
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const current = await m.getAll('oauth', scope);

      const result = await m.patch(
        'oauth',
        scope,
        { ifMatch: current.version, set: { 'oauth.auth_code_ttl': 10.5 } },
        'test_actor'
      );

      expect(result.rejected['oauth.auth_code_ttl']).toContain('integer');
      expect(result.applied).toEqual([]);
    });
  });

  describe('error settings', () => {
    it('cannot be set per client, since error responses are built before a client is known', async () => {
      const m = createSettingsManager({ env: {}, kv: createMockKV(), cacheTTL: 0 });
      m.registerCategory(OAUTH_CATEGORY_META);
      const scope = { type: 'client' as const, id: 'app', tenantId: 'tenant_1' };
      const current = await m.getAll('oauth', scope);

      const result = await m.patch(
        'oauth',
        scope,
        { ifMatch: current.version, set: { 'oauth.error_id_mode': 'none' } },
        'test_actor'
      );

      expect(result.rejected['oauth.error_id_mode']).toContain('Not settable at client scope');
    });
  });

  describe('strict reads', () => {
    it('refuses a stored empty document instead of reading it as unset', async () => {
      const m = createSettingsManager({
        env: {},
        kv: createMockKV({ 'settings:tenant:tenant_1:test': '' }),
        cacheTTL: 0,
        strictReads: true,
      });
      m.registerCategory(TEST_CATEGORY_META);

      await expect(m.getAll('test', { type: 'tenant', id: 'tenant_1' })).rejects.toThrow();
    });
  });

  describe('env values parsed the way runtime reads them', () => {
    const withMeta = (key: string, extra: Partial<SettingMeta>): CategoryMeta => ({
      ...TEST_CATEGORY_META,
      settings: {
        ...TEST_CATEGORY_META.settings,
        [key]: { ...TEST_CATEGORY_META.settings[key], ...extra } as SettingMeta,
      },
    });
    const read = async (meta: CategoryMeta, env: Record<string, string>, key: string) => {
      const m = createSettingsManager({ env, kv: createMockKV(), cacheTTL: 0 });
      m.registerCategory(meta);
      const result = await m.getAll('test', { type: 'platform' });
      return { value: result.values[key], source: result.sources[key] };
    };

    it("ignores a number env value of 0 or less when envNumber is 'positive'", async () => {
      const meta = withMeta('test.number_setting', { envNumber: 'positive' });
      for (const raw of ['0', '-5', 'abc']) {
        expect(await read(meta, { TEST_NUMBER_SETTING: raw }, 'test.number_setting')).toEqual({
          value: 100,
          source: 'default',
        });
      }
      expect(await read(meta, { TEST_NUMBER_SETTING: '30' }, 'test.number_setting')).toEqual({
        value: 30,
        source: 'env',
      });
    });

    it('ignores a number env value that is not a multiple of the step', async () => {
      const meta = withMeta('test.number_setting', { step: 10 });
      expect(await read(meta, { TEST_NUMBER_SETTING: '15' }, 'test.number_setting')).toEqual({
        value: 100,
        source: 'default',
      });
      expect(await read(meta, { TEST_NUMBER_SETTING: '20' }, 'test.number_setting')).toEqual({
        value: 20,
        source: 'env',
      });
    });

    it('ignores an integer env value beyond the safe range for an integer setting', async () => {
      const meta = withMeta('test.number_setting', { integer: true });
      expect(
        await read(meta, { TEST_NUMBER_SETTING: '9007199254740993' }, 'test.number_setting')
      ).toEqual({ value: 100, source: 'default' });
    });

    it("strips one trailing slash from a string env value with envString 'strip-trailing-slash'", async () => {
      const meta = withMeta('test.string_setting', { envString: 'strip-trailing-slash' });
      expect(
        await read(
          meta,
          { TEST_STRING_SETTING: 'https://login.example.com/' },
          'test.string_setting'
        )
      ).toEqual({ value: 'https://login.example.com', source: 'env' });
    });

    it('keeps a 0 number env value without envNumber', async () => {
      expect(
        await read(TEST_CATEGORY_META, { TEST_NUMBER_SETTING: '0' }, 'test.number_setting')
      ).toEqual({ value: 0, source: 'env' });
    });

    it("reads an empty boolean env value as false from env when envEmpty is 'false'", async () => {
      const meta = withMeta('test.boolean_setting', { envEmpty: 'false' });
      expect(await read(meta, { TEST_BOOLEAN_SETTING: '' }, 'test.boolean_setting')).toEqual({
        value: false,
        source: 'env',
      });
      expect(await read(meta, { TEST_BOOLEAN_SETTING: '1' }, 'test.boolean_setting')).toEqual({
        value: true,
        source: 'env',
      });
    });

    it('treats an empty boolean env value as unset by default', async () => {
      expect(
        await read(TEST_CATEGORY_META, { TEST_BOOLEAN_SETTING: '' }, 'test.boolean_setting')
      ).toEqual({ value: true, source: 'default' });
    });
  });

  describe('projection to the runtime KV', () => {
    function canonicalStore() {
      const docs = new Map<string, { data: Record<string, unknown>; version: string }>();
      const keyOf = (category: string, scope: { id: string }) => `${category}:${scope.id}`;
      return {
        load: vi.fn(
          async (category: string, scope: { id: string }) =>
            docs.get(keyOf(category, scope)) ?? null
        ),
        compareAndSet: vi.fn(
          async (
            category: string,
            scope: { id: string },
            expected: string,
            next: { data: Record<string, unknown>; version: string }
          ) => {
            const current = docs.get(keyOf(category, scope));
            if ((current?.version ?? generateVersion({})) !== expected) return false;
            docs.set(keyOf(category, scope), next);
            return true;
          }
        ),
        create: vi.fn(
          async (
            category: string,
            scope: { id: string },
            initial: { data: Record<string, unknown>; version: string }
          ) => {
            const key = keyOf(category, scope);
            if (!docs.has(key)) docs.set(key, initial);
            return docs.get(key)!;
          }
        ),
        markProjected: vi.fn(async () => {}),
        markPending: vi.fn(async () => {}),
        replace: vi.fn(),
        pending: vi.fn(),
      };
    }

    it('says the change is pending when the runtime copy could not be written', async () => {
      const kv = createMockKV();
      (kv.put as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV unavailable'));
      const store = canonicalStore();
      const m = createSettingsManager({
        env: {},
        kv,
        cacheTTL: 0,
        canonicalStore: store as never,
      });
      m.registerCategory(TEST_CATEGORY_META);
      const scope = { type: 'tenant' as const, id: 'tenant_1' };

      const result = await m.patch(
        'test',
        scope,
        { ifMatch: generateVersion({}), set: { 'test.number_setting': 200 } },
        'test_actor'
      );

      expect(result.applied).toContain('test.number_setting');
      expect(result.projection).toBe('pending');
      expect(kv.put).toHaveBeenCalledTimes(3);
      expect(store.markProjected).not.toHaveBeenCalled();
      // The latest version is handed to the scheduled retry even if another save marked it done.
      expect(store.markPending).toHaveBeenCalledWith(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        generateVersion({ 'test.number_setting': 200 })
      );
    });

    it('leaves the runtime copy at the latest save when another save lands during projection', async () => {
      const kv = createMockKV();
      const store = canonicalStore();
      const scope = { type: 'tenant' as const, id: 'tenant_1' };
      const other = createSettingsManager({
        env: {},
        kv,
        cacheTTL: 0,
        canonicalStore: store as never,
      });
      other.registerCategory(TEST_CATEGORY_META);
      const m = createSettingsManager({ env: {}, kv, cacheTTL: 0, canonicalStore: store as never });
      m.registerCategory(TEST_CATEGORY_META);

      // While the first save writes KV, a second save commits and projects its own document.
      const realPut = kv.put as ReturnType<typeof vi.fn>;
      const put = realPut.getMockImplementation()!;
      let interleaved = false;
      realPut.mockImplementation(async (key: string, value: string) => {
        await put(key, value);
        if (!interleaved) {
          interleaved = true;
          const current = await other.getAll('test', scope);
          await other.patch(
            'test',
            scope,
            { ifMatch: current.version, set: { 'test.number_setting': 300 } },
            'other_actor'
          );
        }
      });

      await m.patch(
        'test',
        scope,
        { ifMatch: generateVersion({}), set: { 'test.number_setting': 200 } },
        'test_actor'
      );

      const projected = JSON.parse((await kv.get('settings:tenant:tenant_1:test')) as string);
      expect(projected['test.number_setting']).toBe(300);
    });

    it('does not report a projection state when the runtime copy was written', async () => {
      const store = canonicalStore();
      const m = createSettingsManager({
        env: {},
        kv: createMockKV(),
        cacheTTL: 0,
        canonicalStore: store as never,
      });
      m.registerCategory(TEST_CATEGORY_META);

      const result = await m.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        { ifMatch: generateVersion({}), set: { 'test.number_setting': 200 } },
        'test_actor'
      );

      expect(result.projection).toBeUndefined();
      expect(store.markProjected).toHaveBeenCalledTimes(1);
    });
  });

  describe('audit logging', () => {
    it('should emit audit event on patch', async () => {
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });

      await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: { 'test.string_setting': 'new_value' },
        },
        'test_actor'
      );

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].event).toBe('settings.updated');
      expect(auditEvents[0].actor).toBe('test_actor');
      expect(auditEvents[0].category).toBe('test');
      // Before value is undefined because KV was empty
      expect(auditEvents[0].diff['test.string_setting']).toEqual({
        before: undefined,
        after: 'new_value',
      });
    });

    it('should track before value when updating existing KV setting', async () => {
      // First, set a value
      const initialResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: initialResult.version,
          set: { 'test.string_setting': 'first_value' },
        },
        'test_actor'
      );
      auditEvents.length = 0; // Clear previous events

      // Then update it
      const afterFirstResult = await manager.getAll('test', { type: 'tenant', id: 'tenant_1' });
      await manager.patch(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          ifMatch: afterFirstResult.version,
          set: { 'test.string_setting': 'second_value' },
        },
        'test_actor'
      );

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].diff['test.string_setting']).toEqual({
        before: 'first_value',
        after: 'second_value',
      });
    });
  });

  describe('version generation', () => {
    it('should generate consistent version for same data', () => {
      const data = { key1: 'value1', key2: 123 };
      const version1 = generateVersion(data);
      const version2 = generateVersion(data);

      expect(version1).toBe(version2);
      expect(version1).toMatch(/^sha256:[a-f0-9]+$/);
    });

    it('should generate different versions for different data', () => {
      const version1 = generateVersion({ key: 'value1' });
      const version2 = generateVersion({ key: 'value2' });

      expect(version1).not.toBe(version2);
    });

    it('should normalize key order', () => {
      const version1 = generateVersion({ b: 2, a: 1 });
      const version2 = generateVersion({ a: 1, b: 2 });

      expect(version1).toBe(version2);
    });
  });

  describe('getMeta', () => {
    it('should return category metadata', () => {
      const meta = manager.getMeta('test');

      expect(meta).toBeDefined();
      expect(meta?.category).toBe('test');
      expect(meta?.settings['test.string_setting']).toBeDefined();
    });

    it('should return undefined for unknown category', () => {
      const meta = manager.getMeta('unknown');
      expect(meta).toBeUndefined();
    });
  });

  describe('getRuntimeView', () => {
    it('should return only resolved values', async () => {
      mockKV = createMockKV({
        'settings:tenant:tenant_1:test': JSON.stringify({
          'test.string_setting': 'kv_value',
        }),
      });

      manager = createSettingsManager({
        env: { TEST_NUMBER_SETTING: '999' },
        kv: mockKV,
        cacheTTL: 0,
      });
      manager.registerCategory(TEST_CATEGORY_META);

      const runtime = await manager.getRuntimeView('test', { type: 'tenant', id: 'tenant_1' });

      expect(runtime['test.string_setting']).toBe('kv_value');
      expect(runtime['test.number_setting']).toBe(999);
      expect(runtime['test.boolean_setting']).toBe(true);
      // Should not have version or sources
      expect(runtime).not.toHaveProperty('version');
      expect(runtime).not.toHaveProperty('sources');
    });
  });

  describe('DISABLED_MARKER', () => {
    it('should identify disabled values', () => {
      expect(isDisabled(DISABLED_MARKER)).toBe(true);
      expect(isDisabled('__DISABLED__')).toBe(true);
      expect(isDisabled('normal_value')).toBe(false);
      expect(isDisabled(123)).toBe(false);
      expect(isDisabled(null)).toBe(false);
    });
  });

  describe('client scope', () => {
    it('should use correct KV key for client scope', async () => {
      const result = await manager.getAll('test', {
        type: 'client',
        id: 'client_123',
        tenantId: 'tenant_abc',
      });

      expect(result.scope).toEqual({
        type: 'client',
        id: 'client_123',
        tenantId: 'tenant_abc',
      });
      expect(mockKV.get).toHaveBeenCalledWith('settings:client:tenant_abc:client_123:test');
    });
  });

  describe('inheritance from parent scopes', () => {
    const client = { type: 'client' as const, id: 'client_1', tenantId: 'tenant_1' };
    const parents = [{ type: 'tenant' as const, id: 'tenant_1' }, { type: 'platform' as const }];

    function managerWith(data: Record<string, Record<string, unknown>>, env = {}) {
      const kv = createMockKV(
        Object.fromEntries(Object.entries(data).map(([key, value]) => [key, JSON.stringify(value)]))
      );
      const m = createSettingsManager({ env, kv, cacheTTL: 0 });
      m.registerCategory(TEST_CATEGORY_META);
      return m;
    }

    it('takes a value from the nearest parent that sets it, before env and default', async () => {
      const m = managerWith(
        {
          'settings:platform:test': {
            'test.string_setting': 'platform_value',
            'test.number_setting': 300,
          },
          'settings:tenant:tenant_1:test': { 'test.number_setting': 200 },
        },
        { TEST_STRING_SETTING: 'env_value', TEST_BOOLEAN_SETTING: 'false' }
      );

      const result = await m.getAll('test', client, { parents });

      expect(result.values['test.number_setting']).toBe(200);
      expect(result.sources['test.number_setting']).toBe('tenant');
      expect(result.values['test.string_setting']).toBe('platform_value');
      expect(result.sources['test.string_setting']).toBe('platform');
      expect(result.values['test.boolean_setting']).toBe(false);
      expect(result.sources['test.boolean_setting']).toBe('env');
      expect(result.sources['test.enum_setting']).toBe('default');
    });

    it('reports what a value set here would fall back to', async () => {
      const m = managerWith({
        'settings:tenant:tenant_1:test': { 'test.number_setting': 200 },
        'settings:client:tenant_1:client_1:test': { 'test.number_setting': 50 },
      });

      const result = await m.getAll('test', client, { parents });

      expect(result.values['test.number_setting']).toBe(50);
      expect(result.sources['test.number_setting']).toBe('kv');
      expect(result.inherited.values['test.number_setting']).toBe(200);
      expect(result.inherited.sources['test.number_setting']).toBe('tenant');
      expect(result.inherited.values['test.string_setting']).toBe('default_value');
      expect(result.inherited.sources['test.string_setting']).toBe('default');
    });

    it('reads a disabled parent value as false', async () => {
      const m = managerWith({
        'settings:platform:test': { 'test.boolean_setting': DISABLED_MARKER },
      });

      const result = await m.getAll(
        'test',
        { type: 'tenant', id: 'tenant_1' },
        {
          parents: [{ type: 'platform' }],
        }
      );

      expect(result.values['test.boolean_setting']).toBe(false);
      expect(result.sources['test.boolean_setting']).toBe('platform');
    });

    it('ignores parents unless they are passed', async () => {
      const m = managerWith({
        'settings:platform:test': { 'test.number_setting': 300 },
      });

      const result = await m.getAll('test', { type: 'tenant', id: 'tenant_1' });

      expect(result.values['test.number_setting']).toBe(100);
      expect(result.sources['test.number_setting']).toBe('default');
    });

    it('resolves single values and the runtime view through the same chain', async () => {
      const m = managerWith({
        'settings:tenant:tenant_1:test': { 'test.number_setting': 200 },
      });

      await expect(m.get('test.number_setting', client, { parents })).resolves.toBe(200);
      const runtime = await m.getRuntimeView('test', client, { parents });
      expect(runtime['test.number_setting']).toBe(200);
    });
  });

  describe('get', () => {
    it('finds the category of a key whose prefix differs from the category name', async () => {
      const m = createSettingsManager({ env: {}, kv: createMockKV(), cacheTTL: 0 });
      m.registerCategory({
        ...TEST_CATEGORY_META,
        category: 'test-category',
      });

      await expect(m.get('test.number_setting', { type: 'tenant', id: 'tenant_1' })).resolves.toBe(
        100
      );
      await expect(m.get('test.unknown', { type: 'tenant', id: 'tenant_1' })).rejects.toThrow(
        'Unknown setting'
      );
    });
  });

  describe('security: prototype pollution protection', () => {
    it('should sanitize dangerous keys from KV data', async () => {
      // Simulate malicious KV data with prototype pollution attempt
      mockKV.get.mockResolvedValueOnce(
        JSON.stringify({
          'test.string_setting': 'legitimate_value',
          __proto__: { malicious: true },
          constructor: { malicious: true },
          prototype: { malicious: true },
        })
      );

      const result = await manager.getAll('test', { type: 'tenant', id: 'test_tenant' });

      // The legitimate value should be present
      expect(result.values['test.string_setting']).toBe('legitimate_value');
      // The dangerous keys should NOT be in the result
      // (They would be filtered out by sanitizeObject)
      expect(Object.keys(result.values)).not.toContain('__proto__');
      expect(Object.keys(result.values)).not.toContain('constructor');
      expect(Object.keys(result.values)).not.toContain('prototype');
    });
  });
});
