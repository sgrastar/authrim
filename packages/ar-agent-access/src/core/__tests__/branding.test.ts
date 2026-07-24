import { describe, expect, it } from 'vitest';
import {
  getAgentAccessDisplayName,
  getAgentAccessRecommendedConnectionId,
  normalizeAgentAccessEnvironmentName,
} from '../branding';

describe('Agent Access branding', () => {
  it.each([
    [undefined, 'Authrim', 'authrim'],
    ['', 'Authrim', 'authrim'],
    ['prod', 'Authrim', 'authrim'],
    ['production', 'Authrim', 'authrim'],
    ['test', 'Authrim (test)', 'authrim-test'],
    ['conformance', 'Authrim (conformance)', 'authrim-conformance'],
    [' Preview-1 ', 'Authrim (preview-1)', 'authrim-preview-1'],
  ])('formats environment %j', (environmentName, displayName, connectionId) => {
    expect(getAgentAccessDisplayName(environmentName)).toBe(displayName);
    expect(getAgentAccessRecommendedConnectionId(environmentName)).toBe(connectionId);
  });

  it.each(['TEST ENV', '../test', 'test)', 'a'.repeat(33)])(
    'rejects unsafe or unbounded environment label %j',
    (environmentName) => {
      expect(normalizeAgentAccessEnvironmentName(environmentName)).toBeUndefined();
      expect(getAgentAccessDisplayName(environmentName)).toBe('Authrim');
      expect(getAgentAccessRecommendedConnectionId(environmentName)).toBe('authrim');
    }
  );
});
