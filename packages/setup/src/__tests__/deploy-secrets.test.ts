import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  loadDeploySecretsFromKeys,
  SECRET_UPLOAD_PLAN,
} from '../core/deploy.js';
import { getMissingRequiredDeploySecrets } from '../core/secrets.js';

describe('DEFAULT_SECRET_TARGET_WORKERS', () => {
  it('includes ar-saml so SAML signing secrets are uploaded by default', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).toContain('ar-saml');
  });

  it('does not include workers with no secret requirements', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).not.toContain('ar-router');
    expect(DEFAULT_SECRET_TARGET_WORKERS).toContain('ar-policy');
  });
});

describe('getSecretTargetWorkers', () => {
  it('returns the default secret-bearing workers when no override is provided', () => {
    expect(getSecretTargetWorkers()).toEqual(DEFAULT_SECRET_TARGET_WORKERS);
  });

  it('limits uploads to enabled workers that actually require secrets', () => {
    expect(
      getSecretTargetWorkers([
        'ar-lib-core',
        'ar-discovery',
        'ar-auth',
        'ar-token',
        'ar-userinfo',
        'ar-management',
        'ar-bridge',
        'ar-policy',
        'ar-router',
      ])
    ).toEqual([
      'ar-lib-core',
      'ar-discovery',
      'ar-auth',
      'ar-token',
      'ar-userinfo',
      'ar-management',
      'ar-bridge',
      'ar-policy',
    ]);
  });

  it('keeps ar-saml only when the component is enabled', () => {
    expect(
      getSecretTargetWorkers([
        'ar-lib-core',
        'ar-discovery',
        'ar-auth',
        'ar-token',
        'ar-userinfo',
        'ar-management',
        'ar-saml',
        'ar-router',
      ])
    ).toContain('ar-saml');
  });
});

describe('SECRET_UPLOAD_PLAN', () => {
  it('keeps persistent Cloudflare tokens exclusive to the Control Worker', () => {
    expect(getSecretNamesForWorker('ar-control')).toEqual([
      'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A',
      'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
      'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
      'SMOKE_RPC_SIGNING_JWK_SLOT_A',
      'SMOKE_RPC_SIGNING_JWK_SLOT_B',
      'CLOUDFLARE_D1_API_TOKEN',
      'CLOUDFLARE_WORKERS_API_TOKEN',
      'CLOUDFLARE_KV_API_TOKEN',
      'CLOUDFLARE_R2_API_TOKEN',
    ]);
    for (const component of Object.keys(SECRET_UPLOAD_PLAN).filter(
      (candidate) => candidate !== 'ar-control'
    )) {
      expect(SECRET_UPLOAD_PLAN[component as keyof typeof SECRET_UPLOAD_PLAN]).not.toEqual(
        expect.arrayContaining([
          'CLOUDFLARE_D1_API_TOKEN',
          'CLOUDFLARE_WORKERS_API_TOKEN',
          'CLOUDFLARE_KV_API_TOKEN',
          'CLOUDFLARE_R2_API_TOKEN',
        ])
      );
    }
  });

  it('requires baseline Control tokens but keeps plugin KV and R2 capabilities optional', () => {
    expect(getMissingRequiredDeploySecrets({}, ['ar-control'])).toEqual([
      'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A',
      'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID',
      'SMOKE_RPC_SIGNING_JWK_SLOT_A',
      'CLOUDFLARE_D1_API_TOKEN',
      'CLOUDFLARE_WORKERS_API_TOKEN',
    ]);
    expect(
      getMissingRequiredDeploySecrets(
        {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          CLOUDFLARE_D1_API_TOKEN: 'd1-token',
          CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
        },
        ['ar-control']
      )
    ).toEqual([]);
  });

  it('does not require Cloudflare provisioning tokens when Automatic provisioning is off', () => {
    expect(
      getMissingRequiredDeploySecrets(
        {
          RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
          TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID: 'registry-key',
          SMOKE_RPC_SIGNING_JWK_SLOT_A: '{"kty":"OKP"}',
        },
        ['ar-control'],
        { automaticProvisioning: false }
      )
    ).toEqual([]);
  });

  it('loads split Control tokens only from the process environment without broad-token fallback', async () => {
    const previous = Object.fromEntries(
      [
        'CLOUDFLARE_API_TOKEN',
        'CLOUDFLARE_D1_API_TOKEN',
        'CLOUDFLARE_WORKERS_API_TOKEN',
        'CLOUDFLARE_KV_API_TOKEN',
        'CLOUDFLARE_R2_API_TOKEN',
      ].map((name) => [name, process.env[name]])
    );
    try {
      process.env.CLOUDFLARE_API_TOKEN = 'broad-operator-token';
      delete process.env.CLOUDFLARE_D1_API_TOKEN;
      delete process.env.CLOUDFLARE_WORKERS_API_TOKEN;
      delete process.env.CLOUDFLARE_KV_API_TOKEN;
      delete process.env.CLOUDFLARE_R2_API_TOKEN;
      await expect(loadDeploySecretsFromKeys('/unused', ['ar-control'])).resolves.toEqual({});

      process.env.CLOUDFLARE_D1_API_TOKEN = 'd1-token';
      process.env.CLOUDFLARE_WORKERS_API_TOKEN = 'workers-token';
      process.env.CLOUDFLARE_KV_API_TOKEN = 'kv-token';
      await expect(loadDeploySecretsFromKeys('/unused', ['ar-control'])).resolves.toEqual({
        CLOUDFLARE_D1_API_TOKEN: 'd1-token',
        CLOUDFLARE_WORKERS_API_TOKEN: 'workers-token',
        CLOUDFLARE_KV_API_TOKEN: 'kv-token',
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('uses the dedicated Agent elevation key in both the challenge and target owners', () => {
    expect(getSecretNamesForWorker('ar-agent-access')).toContain('AGENT_ELEVATION_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-management')).toContain('AGENT_ELEVATION_ENCRYPTION_KEY');
  });
  it('fails fresh Workers only for missing required secrets', () => {
    expect(
      getMissingRequiredDeploySecrets(
        {
          PUBLIC_JWK_JSON: '{}',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: '',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: '',
        },
        ['ar-discovery', 'ar-userinfo']
      )
    ).toEqual([
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
      'LOOKUP_HMAC_KEY_SLOT_A',
    ]);
  });

  it('treats provider credentials as optional during a first deployment', () => {
    const authSecrets = Object.fromEntries(
      getSecretNamesForWorker('ar-auth')
        .filter((name) => name !== 'RESEND_API_KEY')
        .map((name) => [name, 'configured'])
    );

    expect(getMissingRequiredDeploySecrets(authSecrets, ['ar-auth'])).toEqual([]);
  });

  it('requires every VC security secret for a first VC deployment', () => {
    const vcSecrets = Object.fromEntries(
      getSecretNamesForWorker('ar-vc')
        .filter((name) => name !== 'VC_PROFILE_CONTRACT_HMAC_SECRET')
        .map((name) => [name, 'configured'])
    );

    expect(getMissingRequiredDeploySecrets(vcSecrets, ['ar-vc'])).toEqual([
      'VC_PROFILE_CONTRACT_HMAC_SECRET',
    ]);
  });

  it('gives discovery only public verification material', () => {
    expect(getSecretNamesForWorker('ar-discovery')).toEqual([
      'PUBLIC_JWK_JSON',
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
    ]);
  });

  it('does not upload broad admin secrets to public discovery', () => {
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('ADMIN_API_SECRET');
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('KEY_MANAGER_SECRET');
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('PRIVATE_KEY_PEM');
  });

  it('uploads downstream introspection credentials only to userinfo', () => {
    expect(getSecretNamesForWorker('ar-userinfo')).toContain(
      'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET'
    );
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET'
    );
  });

  it('uses Durable Object bindings instead of static KeyManager or VersionManager credentials', () => {
    expect(getSecretNamesForWorker('ar-lib-core')).not.toContain('VERSION_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('VERSION_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('ADMIN_API_SECRET');
  });

  it('uploads the logging cursor secret only to management', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('LOGGING_CURSOR_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('LOGGING_CURSOR_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('LOGGING_CURSOR_HMAC_SECRET');
  });

  it('uploads the Flow runtime HMAC secret only to the auth runtime worker', () => {
    expect(getSecretNamesForWorker('ar-auth')).toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
  });

  it('uploads the transaction-code HMAC secret only to the VC worker', () => {
    expect(getSecretNamesForWorker('ar-vc')).toContain('VC_TRANSACTION_CODE_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('VC_TRANSACTION_CODE_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'VC_TRANSACTION_CODE_HMAC_SECRET'
    );
  });

  it('shares only the profile-contract secret between Management and VC', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('VC_PROFILE_CONTRACT_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-vc')).toContain('VC_PROFILE_CONTRACT_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-vc')).toContain('VC_EVIDENCE_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('VC_EVIDENCE_HMAC_SECRET');
  });

  it('uploads TOTP and OTP secret material only to auth-capable workers', () => {
    expect(getSecretNamesForWorker('ar-auth')).toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-management')).toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('PII_ENCRYPTION_KEY');
  });

  it('uploads plugin encryption key only to plugin config/runtime workers', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-discovery')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('PLUGIN_ENCRYPTION_KEY');
  });

  it('keeps notification payload private keys inside Plugin Runner', () => {
    expect(getSecretNamesForWorker('ar-plugin-runner')).toContain(
      'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A'
    );
    expect(getSecretNamesForWorker('ar-plugin-runner')).not.toContain(
      'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS'
    );
    for (const producer of ['ar-auth', 'ar-management'] as const) {
      expect(getSecretNamesForWorker(producer)).toContain(
        'NOTIFICATION_PAYLOAD_ENCRYPTION_PUBLIC_JWKS'
      );
      expect(getSecretNamesForWorker(producer)).not.toContain(
        'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_A'
      );
      expect(getSecretNamesForWorker(producer)).not.toContain(
        'NOTIFICATION_PAYLOAD_DECRYPTION_JWK_SLOT_B'
      );
      expect(getSecretNamesForWorker(producer)).toContain('NOTIFICATION_INTENT_HMAC_KEY');
    }
    expect(getSecretNamesForWorker('ar-plugin-runner')).not.toContain(
      'NOTIFICATION_INTENT_HMAC_KEY'
    );
  });

  it('keeps email sender metadata out of Workers secrets because wrangler vars own those bindings', () => {
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('EMAIL_FROM');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('EMAIL_FROM_NAME');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('EMAIL_FROM');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('EMAIL_FROM_NAME');
  });

  it('does not upload static internal bearer material to SAML or bridge workers', () => {
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('ADMIN_API_SECRET');
    expect(getSecretNamesForWorker('ar-bridge')).toEqual([
      'RP_TOKEN_ENCRYPTION_KEY',
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      'LOOKUP_HMAC_KEY_SLOT_A',
      'LOOKUP_HMAC_KEY_SLOT_B',
      'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
    ]);
    expect(getSecretNamesForWorker('ar-bridge')).not.toContain('ADMIN_API_SECRET');
  });

  it('keeps runtime registry private signing material exclusive to Control', () => {
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID'
    );
    expect(getSecretNamesForWorker('ar-control')).toContain('RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A');
    expect(getSecretNamesForWorker('ar-control')).toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID'
    );
    expect(getSecretNamesForWorker('ar-auth')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-token')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-auth')).toContain(
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'
    );
  });

  it('keeps smoke signing material exclusive to Control and distributes only public JWKS', () => {
    expect(getSecretNamesForWorker('ar-control')).toEqual(
      expect.arrayContaining(['SMOKE_RPC_SIGNING_JWK_SLOT_A', 'SMOKE_RPC_SIGNING_JWK_SLOT_B'])
    );
    for (const [component, names] of Object.entries(SECRET_UPLOAD_PLAN)) {
      if (component === 'ar-control') continue;
      expect(names).not.toEqual(
        expect.arrayContaining(['SMOKE_RPC_SIGNING_JWK_SLOT_A', 'SMOKE_RPC_SIGNING_JWK_SLOT_B'])
      );
    }
    expect(getSecretNamesForWorker('ar-auth')).toContain('CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS');
  });
});
