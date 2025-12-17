/**
 * PII Partition Router Tests
 *
 * Tests for PII database partition routing logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockDatabaseAdapter } from '../../repositories/__tests__/mock-adapter';
import {
  PIIPartitionRouter,
  DEFAULT_PARTITION,
  COUNTRY_TO_PARTITION,
  buildPartitionSettingsKvKey,
  getDefaultPartitionSettings,
  validatePartitionSettings,
  createPIIPartitionRouter,
  clearPartitionSettingsCache,
  type PartitionSettings,
  type PartitionRule,
  type UserPartitionAttributes,
  type CfGeoProperties,
} from '../partition-router';

describe('PIIPartitionRouter', () => {
  let coreAdapter: MockDatabaseAdapter;
  let defaultPiiAdapter: MockDatabaseAdapter;
  let router: PIIPartitionRouter;

  beforeEach(() => {
    clearPartitionSettingsCache();
    coreAdapter = new MockDatabaseAdapter();
    defaultPiiAdapter = new MockDatabaseAdapter();
    coreAdapter.initTable('users_core', 'id');
    router = new PIIPartitionRouter(coreAdapter, defaultPiiAdapter);
  });

  describe('constructor', () => {
    it('should register default partition', () => {
      expect(router.hasPartition(DEFAULT_PARTITION)).toBe(true);
    });

    it('should return available partitions', () => {
      const partitions = router.getAvailablePartitions();
      expect(partitions).toContain(DEFAULT_PARTITION);
    });
  });

  describe('registerPartition', () => {
    it('should register additional partitions', () => {
      const euAdapter = new MockDatabaseAdapter();
      router.registerPartition('eu', euAdapter);

      expect(router.hasPartition('eu')).toBe(true);
      expect(router.getAvailablePartitions()).toContain('eu');
    });

    it('should overwrite existing partition', () => {
      const euAdapter1 = new MockDatabaseAdapter();
      const euAdapter2 = new MockDatabaseAdapter();

      router.registerPartition('eu', euAdapter1);
      router.registerPartition('eu', euAdapter2);

      const adapter = router.getAdapterForPartition('eu');
      expect(adapter).toBe(euAdapter2);
    });
  });

  describe('getAdapterForPartition', () => {
    beforeEach(() => {
      const euAdapter = new MockDatabaseAdapter();
      router.registerPartition('eu', euAdapter);
    });

    it('should return correct adapter for registered partition', () => {
      const adapter = router.getAdapterForPartition('eu');
      expect(adapter).toBeDefined();
      expect(adapter).not.toBe(defaultPiiAdapter);
    });

    it('should fall back to default for unregistered partition', () => {
      const adapter = router.getAdapterForPartition('non-existent');
      expect(adapter).toBe(defaultPiiAdapter);
    });

    it('should return default adapter for default partition', () => {
      const adapter = router.getAdapterForPartition(DEFAULT_PARTITION);
      expect(adapter).toBe(defaultPiiAdapter);
    });
  });

  describe('getAllAdapters', () => {
    it('should return all registered adapters', () => {
      const euAdapter = new MockDatabaseAdapter();
      const apacAdapter = new MockDatabaseAdapter();

      router.registerPartition('eu', euAdapter);
      router.registerPartition('apac', apacAdapter);

      const entries = Array.from(router.getAllAdapters());
      expect(entries).toHaveLength(3); // default, eu, apac

      const keys = entries.map(([k]) => k);
      expect(keys).toContain(DEFAULT_PARTITION);
      expect(keys).toContain('eu');
      expect(keys).toContain('apac');
    });
  });

  describe('resolvePartitionForUser', () => {
    beforeEach(() => {
      coreAdapter.seed('users_core', [
        {
          id: 'user-eu',
          pii_partition: 'eu',
          is_active: 1,
        },
        {
          id: 'user-default',
          pii_partition: 'default',
          is_active: 1,
        },
      ]);
    });

    it('should return partition from users_core', async () => {
      const partition = await router.resolvePartitionForUser('user-eu');
      expect(partition).toBe('eu');
    });

    it('should return default for user with default partition', async () => {
      const partition = await router.resolvePartitionForUser('user-default');
      expect(partition).toBe('default');
    });

    it('should return default for non-existent user', async () => {
      const partition = await router.resolvePartitionForUser('non-existent');
      expect(partition).toBe(DEFAULT_PARTITION);
    });
  });

  describe('resolvePartitionForNewUser', () => {
    const euAdapter = new MockDatabaseAdapter();

    beforeEach(() => {
      router.registerPartition('eu', euAdapter);
      router.registerPartition('apac', new MockDatabaseAdapter());
      router.registerPartition('premium', new MockDatabaseAdapter());
      router.registerPartition('tenant-acme', new MockDatabaseAdapter());
    });

    describe('tenant policy (highest priority)', () => {
      it('should use tenant-specific partition', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'tenant-acme'],
          tenantPartitions: { 'acme-corp': 'tenant-acme' },
          partitionRules: [],
        };

        const result = await router.resolvePartitionForNewUser(
          'acme-corp',
          {},
          undefined,
          settings
        );

        expect(result.partition).toBe('tenant-acme');
        expect(result.method).toBe('tenant_policy');
      });

      it('should skip tenant partition if not registered', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION],
          tenantPartitions: { 'acme-corp': 'unregistered' },
          partitionRules: [],
        };

        const result = await router.resolvePartitionForNewUser(
          'acme-corp',
          {},
          undefined,
          settings
        );

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });
    });

    describe('declared residence (high priority)', () => {
      it('should use declared residence when tenant policy not set', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'eu'],
          tenantPartitions: {},
          partitionRules: [],
        };

        const attributes: UserPartitionAttributes = {
          declared_residence: 'eu',
        };

        const result = await router.resolvePartitionForNewUser(
          'some-tenant',
          attributes,
          undefined,
          settings
        );

        expect(result.partition).toBe('eu');
        expect(result.method).toBe('declared_residence');
      });

      it('should skip declared residence if partition not registered', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION],
          tenantPartitions: {},
          partitionRules: [],
        };

        const attributes: UserPartitionAttributes = {
          declared_residence: 'unregistered',
        };

        const result = await router.resolvePartitionForNewUser(
          'some-tenant',
          attributes,
          undefined,
          settings
        );

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });
    });

    describe('custom rules (medium priority)', () => {
      it('should evaluate rules in priority order', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'premium', 'eu'],
          tenantPartitions: {},
          partitionRules: [
            {
              name: 'premium-users',
              priority: 10,
              condition: { attribute: 'plan', operator: 'eq', value: 'premium' },
              targetPartition: 'premium',
              enabled: true,
            },
            {
              name: 'eu-users',
              priority: 20,
              condition: { attribute: 'region', operator: 'eq', value: 'eu' },
              targetPartition: 'eu',
              enabled: true,
            },
          ],
        };

        const attributes: UserPartitionAttributes = {
          plan: 'premium',
          region: 'eu',
        };

        const result = await router.resolvePartitionForNewUser(
          'some-tenant',
          attributes,
          undefined,
          settings
        );

        // Premium rule has higher priority (lower number)
        expect(result.partition).toBe('premium');
        expect(result.method).toBe('custom_rule');
        expect(result.ruleName).toBe('premium-users');
      });

      it('should skip disabled rules', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'premium'],
          tenantPartitions: {},
          partitionRules: [
            {
              name: 'disabled-rule',
              priority: 1,
              condition: { attribute: 'plan', operator: 'eq', value: 'premium' },
              targetPartition: 'premium',
              enabled: false,
            },
          ],
        };

        const attributes: UserPartitionAttributes = {
          plan: 'premium',
        };

        const result = await router.resolvePartitionForNewUser(
          'some-tenant',
          attributes,
          undefined,
          settings
        );

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });

      it('should evaluate "in" operator correctly', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'premium'],
          tenantPartitions: {},
          partitionRules: [
            {
              name: 'premium-plans',
              priority: 1,
              condition: { attribute: 'plan', operator: 'in', value: ['premium', 'enterprise'] },
              targetPartition: 'premium',
              enabled: true,
            },
          ],
        };

        const result1 = await router.resolvePartitionForNewUser(
          'tenant',
          { plan: 'enterprise' },
          undefined,
          settings
        );
        expect(result1.partition).toBe('premium');

        const result2 = await router.resolvePartitionForNewUser(
          'tenant',
          { plan: 'free' },
          undefined,
          settings
        );
        expect(result2.partition).toBe(DEFAULT_PARTITION);
      });

      it('should evaluate numeric operators correctly', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'premium'],
          tenantPartitions: {},
          partitionRules: [
            {
              name: 'high-value-users',
              priority: 1,
              condition: { attribute: 'spend', operator: 'gte', value: 1000 },
              targetPartition: 'premium',
              enabled: true,
            },
          ],
        };

        const result1 = await router.resolvePartitionForNewUser(
          'tenant',
          { spend: 1500 },
          undefined,
          settings
        );
        expect(result1.partition).toBe('premium');

        const result2 = await router.resolvePartitionForNewUser(
          'tenant',
          { spend: 500 },
          undefined,
          settings
        );
        expect(result2.partition).toBe(DEFAULT_PARTITION);
      });
    });

    describe('IP routing (low priority, fallback)', () => {
      it('should use IP routing when enabled and no higher priority match', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: true,
          availablePartitions: [DEFAULT_PARTITION, 'eu'],
          tenantPartitions: {},
          partitionRules: [],
        };

        const cfData: CfGeoProperties = {
          country: 'DE', // Germany → eu
        };

        const result = await router.resolvePartitionForNewUser('some-tenant', {}, cfData, settings);

        expect(result.partition).toBe('eu');
        expect(result.method).toBe('ip_routing');
      });

      it('should not use IP routing when disabled', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION, 'eu'],
          tenantPartitions: {},
          partitionRules: [],
        };

        const cfData: CfGeoProperties = {
          country: 'DE',
        };

        const result = await router.resolvePartitionForNewUser('some-tenant', {}, cfData, settings);

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });

      it('should fall back to default for unrecognized country', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: true,
          availablePartitions: [DEFAULT_PARTITION, 'eu'],
          tenantPartitions: {},
          partitionRules: [],
        };

        const cfData: CfGeoProperties = {
          country: 'ZZ', // Unknown country
        };

        const result = await router.resolvePartitionForNewUser('some-tenant', {}, cfData, settings);

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });
    });

    describe('default partition (lowest priority)', () => {
      it('should use default when no rules match', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: false,
          availablePartitions: [DEFAULT_PARTITION],
          tenantPartitions: {},
          partitionRules: [],
        };

        const result = await router.resolvePartitionForNewUser(
          'some-tenant',
          {},
          undefined,
          settings
        );

        expect(result.partition).toBe(DEFAULT_PARTITION);
        expect(result.method).toBe('default');
      });
    });

    describe('trust hierarchy integration', () => {
      it('should prefer tenant policy over declared residence', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: true,
          availablePartitions: [DEFAULT_PARTITION, 'eu', 'tenant-acme'],
          tenantPartitions: { 'acme-corp': 'tenant-acme' },
          partitionRules: [],
        };

        const attributes: UserPartitionAttributes = {
          declared_residence: 'eu',
        };

        const cfData: CfGeoProperties = {
          country: 'JP', // Would normally route to apac
        };

        const result = await router.resolvePartitionForNewUser(
          'acme-corp',
          attributes,
          cfData,
          settings
        );

        // Tenant policy wins
        expect(result.partition).toBe('tenant-acme');
        expect(result.method).toBe('tenant_policy');
      });

      it('should prefer declared residence over custom rules', async () => {
        const settings: PartitionSettings = {
          defaultPartition: DEFAULT_PARTITION,
          ipRoutingEnabled: true,
          availablePartitions: [DEFAULT_PARTITION, 'eu', 'premium'],
          tenantPartitions: {},
          partitionRules: [
            {
              name: 'premium',
              priority: 1,
              condition: { attribute: 'plan', operator: 'eq', value: 'premium' },
              targetPartition: 'premium',
              enabled: true,
            },
          ],
        };

        const attributes: UserPartitionAttributes = {
          declared_residence: 'eu',
          plan: 'premium',
        };

        const result = await router.resolvePartitionForNewUser(
          'tenant',
          attributes,
          undefined,
          settings
        );

        // Declared residence wins over custom rule
        expect(result.partition).toBe('eu');
        expect(result.method).toBe('declared_residence');
      });
    });
  });
});

describe('COUNTRY_TO_PARTITION', () => {
  it('should map EU countries to eu partition', () => {
    const euCountries = ['DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PL', 'SE', 'FI'];

    for (const country of euCountries) {
      expect(COUNTRY_TO_PARTITION[country]).toBe('eu');
    }
  });

  it('should map US to us partition', () => {
    expect(COUNTRY_TO_PARTITION['US']).toBe('us');
  });

  it('should map APAC countries to apac partition', () => {
    const apacCountries = ['JP', 'KR', 'AU', 'NZ', 'SG', 'HK', 'TW', 'IN'];

    for (const country of apacCountries) {
      expect(COUNTRY_TO_PARTITION[country]).toBe('apac');
    }
  });

  it('should map UK to eu partition', () => {
    expect(COUNTRY_TO_PARTITION['GB']).toBe('eu');
  });
});

describe('buildPartitionSettingsKvKey', () => {
  it('should build correct key', () => {
    expect(buildPartitionSettingsKvKey('default')).toBe('pii_partition_config:default');
    expect(buildPartitionSettingsKvKey('tenant-acme')).toBe('pii_partition_config:tenant-acme');
  });
});

describe('getDefaultPartitionSettings', () => {
  it('should return default settings', () => {
    const settings = getDefaultPartitionSettings();

    expect(settings.defaultPartition).toBe(DEFAULT_PARTITION);
    expect(settings.ipRoutingEnabled).toBe(false);
    expect(settings.tenantPartitions).toEqual({});
    expect(settings.partitionRules).toEqual([]);
    expect(settings.updatedAt).toBeDefined();
  });

  it('should use provided available partitions', () => {
    const settings = getDefaultPartitionSettings(['default', 'eu', 'apac']);

    expect(settings.availablePartitions).toEqual(['default', 'eu', 'apac']);
  });
});

describe('validatePartitionSettings', () => {
  const availablePartitions = ['default', 'eu', 'apac', 'premium'];

  it('should accept valid settings', () => {
    const settings: PartitionSettings = {
      defaultPartition: 'default',
      ipRoutingEnabled: false,
      availablePartitions: ['default', 'eu'],
      tenantPartitions: { acme: 'eu' },
      partitionRules: [
        {
          name: 'premium',
          priority: 1,
          condition: { attribute: 'plan', operator: 'eq', value: 'premium' },
          targetPartition: 'premium',
          enabled: true,
        },
      ],
    };

    const result = validatePartitionSettings(settings, availablePartitions);
    expect(result.valid).toBe(true);
  });

  it('should reject invalid default partition', () => {
    const settings: PartitionSettings = {
      defaultPartition: 'non-existent',
      ipRoutingEnabled: false,
      availablePartitions: [],
      tenantPartitions: {},
      partitionRules: [],
    };

    const result = validatePartitionSettings(settings, availablePartitions);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Default partition');
    expect(result.error).toContain('not available');
  });

  it('should reject invalid tenant partition', () => {
    const settings: PartitionSettings = {
      defaultPartition: 'default',
      ipRoutingEnabled: false,
      availablePartitions: ['default'],
      tenantPartitions: { acme: 'non-existent' },
      partitionRules: [],
    };

    const result = validatePartitionSettings(settings, availablePartitions);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Tenant 'acme'");
    expect(result.error).toContain('not available');
  });

  it('should reject invalid rule target partition', () => {
    const settings: PartitionSettings = {
      defaultPartition: 'default',
      ipRoutingEnabled: false,
      availablePartitions: ['default'],
      tenantPartitions: {},
      partitionRules: [
        {
          name: 'invalid',
          priority: 1,
          condition: { attribute: 'plan', operator: 'eq', value: 'x' },
          targetPartition: 'non-existent',
          enabled: true,
        },
      ],
    };

    const result = validatePartitionSettings(settings, availablePartitions);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Rule 'invalid'");
    expect(result.error).toContain('not available');
  });

  it('should reject duplicate rule names', () => {
    const settings: PartitionSettings = {
      defaultPartition: 'default',
      ipRoutingEnabled: false,
      availablePartitions: ['default', 'eu'],
      tenantPartitions: {},
      partitionRules: [
        {
          name: 'duplicate',
          priority: 1,
          condition: { attribute: 'a', operator: 'eq', value: '1' },
          targetPartition: 'eu',
          enabled: true,
        },
        {
          name: 'duplicate',
          priority: 2,
          condition: { attribute: 'b', operator: 'eq', value: '2' },
          targetPartition: 'eu',
          enabled: true,
        },
      ],
    };

    const result = validatePartitionSettings(settings, availablePartitions);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Duplicate rule names');
  });
});

describe('createPIIPartitionRouter', () => {
  it('should create router with default partition', () => {
    const coreAdapter = new MockDatabaseAdapter();
    const piiAdapter = new MockDatabaseAdapter();

    const router = createPIIPartitionRouter(coreAdapter, piiAdapter);

    expect(router.hasPartition(DEFAULT_PARTITION)).toBe(true);
    expect(router.getAvailablePartitions()).toContain(DEFAULT_PARTITION);
  });

  it('should register additional partitions', () => {
    const coreAdapter = new MockDatabaseAdapter();
    const piiAdapter = new MockDatabaseAdapter();
    const euAdapter = new MockDatabaseAdapter();
    const apacAdapter = new MockDatabaseAdapter();

    const additionalPartitions = new Map([
      ['eu', euAdapter],
      ['apac', apacAdapter],
    ]);

    const router = createPIIPartitionRouter(coreAdapter, piiAdapter, additionalPartitions);

    expect(router.hasPartition('eu')).toBe(true);
    expect(router.hasPartition('apac')).toBe(true);
    expect(router.getAvailablePartitions()).toHaveLength(3);
  });
});
