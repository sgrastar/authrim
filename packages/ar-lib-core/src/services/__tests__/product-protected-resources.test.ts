import { describe, expect, it } from 'vitest';
import {
  getProductProtectedResourceDefinition,
  resolveProductProtectedResourceAudience,
} from '../product-protected-resources';

describe('VC product protected-resource contract', () => {
  it('routes verified-attribute reads to the mounted self-service endpoint', () => {
    expect(getProductProtectedResourceDefinition('verified_attribute')).toMatchObject({
      defaultAudience: 'svc://op-vc/attribute-elevation',
      routePathTemplate: '/vp/attributes',
      servicePackage: '@authrim/ar-vc',
    });
    expect(resolveProductProtectedResourceAudience({ resourceClass: 'verified_attribute' })).toBe(
      'svc://op-vc/attribute-elevation'
    );
  });
});
