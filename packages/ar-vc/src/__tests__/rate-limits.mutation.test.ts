import { describe, expect, it } from 'vitest';
import { VC_RATE_LIMITS } from '../rate-limits';

describe('VC rate limits: presentation definition lookup', () => {
  it('has a bucket of its own, like the request object it accompanies', () => {
    const limit = VC_RATE_LIMITS.find((entry) => entry.path === '/vp/pd/*');
    expect(limit).toMatchObject({
      endpoint: '/vp/pd/',
      profile: 'lenient',
      endpointClass: 'vp_presentation_definition',
    });
    const request = VC_RATE_LIMITS.find((entry) => entry.path === '/vp/request/*');
    expect(limit?.profile).toBe(request?.profile);
    expect(limit?.endpointClass).not.toBe(request?.endpointClass);
  });
});
