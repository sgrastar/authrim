/**
 * Naming Module Tests
 */

import { describe, it, expect } from 'vitest';
import {
  getWorkerName,
  getD1DatabaseName,
  getKVNamespaceName,
  getDeploymentOrder,
  getEnabledComponents,
  CORE_WORKER_COMPONENTS,
  WORKER_COMPONENTS,
  WORKER_DEPLOYMENT_DEPENDENCIES,
  getBuiltinD1BindingsForComponent,
} from '../core/naming.js';

describe('Worker Naming', () => {
  it('should generate correct worker name', () => {
    expect(getWorkerName('prod', 'ar-auth')).toBe('prod-ar-auth');
    expect(getWorkerName('staging', 'ar-token')).toBe('staging-ar-token');
    expect(getWorkerName('dev', 'ar-lib-core')).toBe('dev-ar-lib-core');
  });
});

describe('D1 Database Naming', () => {
  it('should generate correct database name', () => {
    // dbType includes the '-db' suffix as defined in D1_DATABASES
    expect(getD1DatabaseName('prod', 'core-db')).toBe('prod-authrim-core-db');
    expect(getD1DatabaseName('staging', 'pii-db')).toBe('staging-authrim-pii-db');
  });
});

describe('KV Namespace Naming', () => {
  it('should generate correct KV namespace name', () => {
    expect(getKVNamespaceName('prod', 'CLIENTS_CACHE')).toBe('PROD-CLIENTS_CACHE');
    expect(getKVNamespaceName('staging', 'SETTINGS')).toBe('STAGING-SETTINGS');
    expect(getKVNamespaceName('prod', 'TENANT_RUNTIME_REGISTRY')).toBe(
      'PROD-TENANT_RUNTIME_REGISTRY'
    );
  });
});

describe('Component Lists', () => {
  it('should have all core components', () => {
    expect(CORE_WORKER_COMPONENTS).toContain('ar-lib-core');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-auth');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-token');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-control');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-agent-access');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-saml');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-async');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-vc');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-router');
  });

  it('should have more components in full list', () => {
    expect(WORKER_COMPONENTS.length).toBeGreaterThanOrEqual(CORE_WORKER_COMPONENTS.length);
  });
});

describe('getEnabledComponents', () => {
  it('should return core components by default', () => {
    const components = getEnabledComponents({});

    expect(components.has('ar-lib-core')).toBe(true);
    expect(components.has('ar-auth')).toBe(true);
    expect(components.has('ar-token')).toBe(true);
    expect(components.has('ar-agent-access')).toBe(true);
    expect(components.has('ar-router')).toBe(true);
  });

  it('should include standard components when enabled', () => {
    const components = getEnabledComponents({
      saml: true,
      vc: true,
    });

    expect(components.has('ar-saml')).toBe(true);
    expect(components.has('ar-vc')).toBe(true);
  });

  it('should keep standard components even when old configs disable them', () => {
    const components = getEnabledComponents({
      saml: false,
      vc: false,
    });

    expect(components.has('ar-saml')).toBe(true);
    expect(components.has('ar-vc')).toBe(true);
  });
});

describe('getDeploymentOrder', () => {
  it('should return deployment levels for core components', () => {
    const components = getEnabledComponents({});
    const levels = getDeploymentOrder(components);

    expect(levels.length).toBeGreaterThan(0);

    // First level should contain ar-lib-core (DO definition source)
    expect(levels[0]).toContain('ar-lib-core');

    // Last level should contain ar-router
    expect(levels[levels.length - 1]).toContain('ar-router');
  });

  it('should include SAML in correct level', () => {
    const components = getEnabledComponents({ saml: true });
    const levels = getDeploymentOrder(components);

    // Flatten levels to check SAML is included
    const allComponents = levels.flat();
    expect(allComponents).toContain('ar-saml');

    // SAML should come before router
    const samlIndex = allComponents.indexOf('ar-saml');
    const routerIndex = allComponents.indexOf('ar-router');
    expect(samlIndex).toBeLessThan(routerIndex);
  });
});

describe('WORKER_DEPLOYMENT_DEPENDENCIES', () => {
  it('should require ar-lib-core before every other Worker', () => {
    for (const component of WORKER_COMPONENTS.filter(
      (worker) =>
        worker !== 'ar-lib-core' && worker !== 'ar-control' && worker !== 'ar-plugin-runner'
    )) {
      expect(WORKER_DEPLOYMENT_DEPENDENCIES[component]).toContain('ar-lib-core');
    }
  });

  it('deploys the private control plane independently before its management caller', () => {
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-control']).toEqual([]);
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-plugin-runner']).toEqual([]);
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-management']).toContain('ar-control');
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-management']).toContain('ar-plugin-runner');
  });

  it('should require ar-bridge before ar-auth', () => {
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-auth']).toContain('ar-bridge');
  });

  it('should require every service-binding target before ar-management', () => {
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-management']).toEqual(
      expect.arrayContaining(['ar-auth', 'ar-bridge', 'ar-vc'])
    );
  });

  it('should deploy Agent Access only after its token and management dependencies', () => {
    expect(WORKER_DEPLOYMENT_DEPENDENCIES['ar-agent-access']).toEqual(
      expect.arrayContaining(['ar-lib-core', 'ar-token', 'ar-management'])
    );
  });

  it('should require every API target before ar-router', () => {
    const apiTargets = CORE_WORKER_COMPONENTS.filter(
      (component) =>
        component !== 'ar-router' && component !== 'ar-control' && component !== 'ar-plugin-runner'
    );

    expect([...WORKER_DEPLOYMENT_DEPENDENCIES['ar-router']].sort()).toEqual([...apiTargets].sort());
  });
});

describe('getBuiltinD1BindingsForComponent', () => {
  it('keeps control-plane databases out of runtime Workers', () => {
    expect(getBuiltinD1BindingsForComponent('ar-control')).toEqual(['CONTROL_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-plugin-runner')).toEqual(['PLUGIN_RUNNER_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-auth')).toEqual([
      'DB',
      'DB_PII',
      'DB_ADMIN',
      'LOOKUP_DB',
    ]);
    expect(getBuiltinD1BindingsForComponent('ar-management')).toEqual([
      'DB',
      'DB_PII',
      'DB_ADMIN',
      'LOOKUP_DB',
    ]);
    expect(getBuiltinD1BindingsForComponent('ar-token')).toEqual(['DB_ADMIN', 'LOOKUP_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-userinfo')).toEqual(['LOOKUP_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-bridge')).toEqual(['DB', 'DB_PII', 'LOOKUP_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-discovery')).toEqual([]);
    expect(getBuiltinD1BindingsForComponent('ar-policy')).toEqual([]);
    expect(getBuiltinD1BindingsForComponent('ar-agent-access')).toEqual(['DB_ADMIN']);
    expect(getBuiltinD1BindingsForComponent('ar-async')).toEqual([]);
    expect(getBuiltinD1BindingsForComponent('ar-saml')).toEqual(['DB', 'DB_PII', 'DB_ADMIN']);
    expect(getBuiltinD1BindingsForComponent('ar-vc')).toEqual(['DB_ADMIN']);
    expect(getBuiltinD1BindingsForComponent('ar-lib-core')).toEqual(['DB', 'DB_PII', 'LOOKUP_DB']);
    expect(getBuiltinD1BindingsForComponent('ar-router')).toEqual([]);
    expect(getBuiltinD1BindingsForComponent('ar-auth')).not.toContain('PLUGIN_RUNNER_DB');
    expect(getBuiltinD1BindingsForComponent('ar-auth')).not.toContain('CONTROL_DB');
  });
});
