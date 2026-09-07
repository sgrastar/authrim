import { describe, expect, it } from 'vitest';
import { canonicalizeJson } from '@authrim/ar-agent-access/core';
import { buildAgentElevatedSettingsToolInput } from '../routes/settings-v2';

describe('Agent settings elevation argument binding', () => {
  it('reconstructs the exact assurance Tool input after the platform route projection', () => {
    const original = {
      resource_version: 'version-1',
      enabled: true,
      defaultAAL: 'AAL2',
      scopeAALRequirements: { 'payments:write': 'AAL3' },
    };
    const reconstructed = buildAgentElevatedSettingsToolInput('assurance', {
      ifMatch: 'version-1',
      set: {
        'assurance.enabled': true,
        'assurance.default_aal': 'AAL2',
        'assurance.scope_aal_requirements': canonicalizeJson({ 'payments:write': 'AAL3' }),
      },
    });
    expect(reconstructed).toEqual({
      operation: 'admin.write.assurance.update',
      input: original,
    });
  });

  it('keeps nested security input and rejects unrelated categories from elevation binding', () => {
    expect(
      buildAgentElevatedSettingsToolInput('security', {
        ifMatch: 'version-2',
        set: {
          'security.fapi_enabled': true,
          'security.fapi_strict_dpop': false,
        },
      })
    ).toEqual({
      operation: 'admin.write.protocol-security.update',
      input: {
        resource_version: 'version-2',
        fapi: { enabled: true, strictDPoP: false },
      },
    });
    expect(buildAgentElevatedSettingsToolInput('email', {})).toBeNull();
  });

  it('reconstructs OAuth and session inputs while leaving standard Login UI writes unfenced', () => {
    expect(
      buildAgentElevatedSettingsToolInput('oauth', {
        ifMatch: 'version-3',
        set: {
          'oauth.access_token_expiry': 900,
          'oauth.refresh_token_rotation': true,
        },
      })
    ).toEqual({
      operation: 'admin.write.oauth.update',
      input: {
        resource_version: 'version-3',
        accessTokenExpiry: 900,
        refreshTokenRotation: true,
      },
    });
    expect(
      buildAgentElevatedSettingsToolInput('session', {
        ifMatch: 'version-4',
        set: { 'session.refresh_default': false },
      })
    ).toEqual({
      operation: 'admin.write.session.update',
      input: { resource_version: 'version-4', refreshDefault: false },
    });
    expect(buildAgentElevatedSettingsToolInput('login-ui', {})).toBeNull();
  });
});
