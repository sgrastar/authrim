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
