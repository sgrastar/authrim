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
  });
});

describe('Component Lists', () => {
  it('should have all core components', () => {
    expect(CORE_WORKER_COMPONENTS).toContain('ar-lib-core');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-auth');
    expect(CORE_WORKER_COMPONENTS).toContain('ar-token');
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
    expect(components.has('ar-router')).toBe(true);
  });

  it('should add optional components when enabled', () => {
    const components = getEnabledComponents({
      saml: true,
      vc: true,
    });

    expect(components.has('ar-saml')).toBe(true);
    expect(components.has('ar-vc')).toBe(true);
  });

  it('should not include optional components when disabled', () => {
    const components = getEnabledComponents({
      saml: false,
      vc: false,
    });

    expect(components.has('ar-saml')).toBe(false);
    expect(components.has('ar-vc')).toBe(false);
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
