#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DEFAULT_LEDGER = 'security/asvs/v5.0.0/l1-auth.yml';
const DEFAULT_JSON_OUTPUT = 'security/asvs/asvs-coverage-summary.json';
const DEFAULT_REPORT_ROOT = 'docs/reports/asvs';
const EXPECTED_ASVS_VERSION = '5.0.0';
const EXPECTED_LEVEL = 1;
const EXPECTED_CONTROL_IDS = [
  'v5.0.0-V6.1.1',
  'v5.0.0-V6.2.1',
  'v5.0.0-V6.2.2',
  'v5.0.0-V6.2.3',
  'v5.0.0-V6.2.4',
  'v5.0.0-V6.2.5',
  'v5.0.0-V6.2.6',
  'v5.0.0-V6.2.7',
  'v5.0.0-V6.2.8',
  'v5.0.0-V6.3.1',
  'v5.0.0-V6.3.2',
  'v5.0.0-V6.4.1',
  'v5.0.0-V6.4.2',
  'v5.0.0-V7.2.1',
  'v5.0.0-V7.2.2',
  'v5.0.0-V7.2.3',
  'v5.0.0-V7.2.4',
  'v5.0.0-V7.4.1',
  'v5.0.0-V7.4.2',
  'v5.0.0-V10.4.1',
  'v5.0.0-V10.4.2',
  'v5.0.0-V10.4.3',
  'v5.0.0-V10.4.4',
  'v5.0.0-V10.4.5',
];
const EXPECTED_CHAPTERS = new Set(['V6', 'V7', 'V10']);
const STATUSES = ['covered', 'manual', 'not_applicable', 'gap'];
const SECTION_NAMES = new Map([
  ['V6.1', 'Authentication Documentation'],
  ['V6.2', 'Password Security'],
  ['V6.3', 'General Authentication Security'],
  ['V6.4', 'Authentication Factor Lifecycle and Recovery'],
  ['V7.2', 'Fundamental Session Management Security'],
  ['V7.4', 'Session Termination'],
  ['V10.4', 'OAuth Authorization Server'],
]);

function displayResult(status) {
  return (
    {
      covered: 'Evidence covered',
      manual: 'Manual',
      not_applicable: 'Not applicable',
      gap: 'Gap',
    }[status] ?? status
  );
}

function shortRequirementId(id) {
  return String(id).replace(/^v\d+\.\d+\.\d+-/, '');
}

function escapeMarkdownTable(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
}

function testIdFor(controlId, index) {
  return `${shortRequirementId(controlId)}-${index + 1}`;
}

async function readText(repoRoot, filePath) {
  return fs.readFile(path.resolve(repoRoot, filePath), 'utf8');
}

async function collectFiles(repoRoot, dirs, extensions) {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      const relativePath = path.relative(repoRoot, entryPath);
      if (
        entry.name === 'node_modules' ||
        entry.name === 'coverage' ||
        entry.name === 'dist' ||
        entry.name === '.svelte-kit' ||
        relativePath.includes(`${path.sep}__tests__${path.sep}`) ||
        /\.test\.[cm]?[jt]sx?$/.test(entry.name) ||
        /\.spec\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        results.push(relativePath);
      }
    }
  }

  for (const dir of dirs) {
    await walk(path.resolve(repoRoot, dir));
  }

  return results.sort();
}

function requirePattern(content, pattern, description) {
  if (!pattern.test(content)) {
    throw new Error(description);
  }
}

function forbidPattern(content, pattern, description) {
  const match = content.match(pattern);
  if (match) {
    throw new Error(`${description}: ${match[0].slice(0, 160)}`);
  }
}

async function runIndependentCheck(repoRoot, id) {
  if (id === 'asvs.v6_1_1.documentation_keywords') {
    const notes = await readText(repoRoot, 'docs/testing/asvs-v5-l1-auth-notes.md');
    requirePattern(notes, /rate limiting/i, 'ASVS notes must mention rate limiting.');
    requirePattern(notes, /anti-automation/i, 'ASVS notes must mention anti-automation.');
    requirePattern(
      notes,
      /malicious account lockout/i,
      'ASVS notes must mention malicious account lockout prevention.'
    );
    return {
      id,
      result: 'pass',
      description:
        'ASVS scope notes contain required documentation anchors for rate limiting, anti-automation, and malicious account lockout prevention.',
      evidence: 'docs/testing/asvs-v5-l1-auth-notes.md',
    };
  }

  if (id === 'asvs.v6_3_2.no_seeded_default_admin_accounts') {
    const sqlFiles = await collectFiles(repoRoot, ['migrations'], new Set(['.sql']));
    const setupFiles = await collectFiles(repoRoot, ['packages/setup/src'], new Set(['.ts']));
    const files = [...sqlFiles, ...setupFiles, 'packages/ar-auth/src/setup.ts'];
    const defaultAccountInsert =
      /INSERT\s+INTO\s+(?:admin_users|users)\b[\s\S]{0,900}(?:'root'|'admin'|'sa'|"root"|"admin"|"sa"|root@|admin@|sa@)/i;

    for (const file of files) {
      const content = await readText(repoRoot, file);
      forbidPattern(content, defaultAccountInsert, `${file} must not seed default accounts`);
    }

    return {
      id,
      result: 'pass',
      description:
        'Migrations and setup source do not seed enabled root/admin/sa default user accounts.',
      evidence: `${files.length} migration/setup files scanned`,
    };
  }

  if (id === 'asvs.v6_3_2.setup_requires_token_and_disables_after_first_admin') {
    const setup = await readText(repoRoot, 'packages/ar-auth/src/setup.ts');
    const setupToken = await readText(repoRoot, 'packages/ar-lib-core/src/utils/setup-token.ts');
    requirePattern(
      setup,
      /validateSetupToken\(c\.env,\s*setup_token\)/,
      'Setup must validate token.'
    );
    requirePattern(
      setup,
      /isSystemInitialized\(c\.env\)/,
      'Setup must reject initialized systems.'
    );
    requirePattern(setup, /checkSetupEnabled/, 'Setup routes must check setup enabled state.');
    requirePattern(setup, /completeSetup\(c\.env\)/, 'Setup completion must call completeSetup.');
    requirePattern(
      setupToken,
      /delete\(SETUP_TOKEN_KEY\)/,
      'completeSetup must delete setup token.'
    );
    requirePattern(
      setupToken,
      /put\(SETUP_COMPLETED_KEY,\s*'true'\)/,
      'completeSetup must set permanent completion flag.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Initial admin setup requires a setup token, rejects already-initialized systems, and permanently disables setup after completion.',
      evidence: 'packages/ar-auth/src/setup.ts; packages/ar-lib-core/src/utils/setup-token.ts',
    };
  }

  if (id === 'asvs.v6_4_1.setup_token_entropy_and_ttl') {
    const setupToken = await readText(repoRoot, 'packages/ar-lib-core/src/utils/setup-token.ts');
    const setupKeys = await readText(repoRoot, 'scripts/setup-keys.sh');
    const setupCoreAdmin = await readText(repoRoot, 'packages/setup/src/core/admin.ts');
    requirePattern(
      setupToken,
      /generateSecureRandomString\(32\)/,
      'Generated setup tokens must use at least 32 random bytes.'
    );
    requirePattern(
      setupToken,
      /DEFAULT_SETUP_TOKEN_TTL\s*=\s*3600/,
      'Default setup token TTL must be one hour.'
    );
    requirePattern(
      setupToken,
      /expirationTtl:\s*ttlSeconds/,
      'Stored setup tokens must use expirationTtl.'
    );
    requirePattern(
      setupKeys,
      /head -c 32 \/dev\/urandom/,
      'Shell setup token must use 32 random bytes.'
    );
    requirePattern(
      setupKeys,
      /--expiration-ttl=3600/,
      'Shell setup token must be stored with one hour TTL.'
    );
    requirePattern(
      setupCoreAdmin,
      /\[A-Za-z0-9_-\]\{43\}/,
      'Setup CLI must validate base64url 32-byte token format.'
    );
    requirePattern(
      setupCoreAdmin,
      /'--ttl'[\s\S]{0,80}ttlSeconds\.toString\(\)/,
      'Setup CLI must pass TTL to Wrangler.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Setup token generation uses 32 random bytes and all storage paths enforce expiring setup tokens.',
      evidence:
        'packages/ar-lib-core/src/utils/setup-token.ts; scripts/setup-keys.sh; packages/setup/src/core/admin.ts',
    };
  }

  if (id === 'asvs.v6_4_1.admin_ui_setup_token_lifecycle') {
    const setup = await readText(repoRoot, 'packages/ar-auth/src/setup.ts');
    const schema = await readText(repoRoot, 'migrations/admin/001_0_4_0_admin_baseline.sql');
    const base = await readText(repoRoot, 'packages/ar-lib-core/src/repositories/base.ts');
    requirePattern(base, /crypto\.randomUUID\(\)/, 'Repository IDs must use crypto.randomUUID.');
    requirePattern(
      setup,
      /const setupTokenId = generateId\(\)/,
      'Admin UI setup token ID must be generated.'
    );
    requirePattern(
      setup,
      /tokenExpiresAt\s*=\s*now\s*\+\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
      'Admin UI setup token must expire within 24 hours.'
    );
    requirePattern(
      setup,
      /INSERT INTO admin_setup_tokens/,
      'Admin UI setup token must be inserted.'
    );
    requirePattern(
      setup,
      /status,\s*expires_at,\s*created_at,\s*created_by/,
      'Admin UI setup token insert must include status and expires_at columns.'
    );
    requirePattern(
      setup,
      /VALUES \(\?, \?, \?, 'pending', \?, \?, 'initial_setup'\)/,
      'Admin UI setup token insert must start with pending status.'
    );
    requirePattern(
      schema,
      /status TEXT NOT NULL DEFAULT 'pending'/,
      'Setup token schema must have status.'
    );
    requirePattern(
      schema,
      /expires_at INTEGER NOT NULL/,
      'Setup token schema must require expires_at.'
    );
    requirePattern(schema, /used_at INTEGER/, 'Setup token schema must track used_at.');

    return {
      id,
      result: 'pass',
      description:
        'Admin UI passkey setup tokens are random UUIDs, start pending, expire, and have status/usage tracking.',
      evidence:
        'packages/ar-auth/src/setup.ts; packages/ar-lib-core/src/repositories/base.ts; migrations/admin/001_0_4_0_admin_baseline.sql',
    };
  }

  if (id === 'asvs.v6_4_2.no_password_hints_or_kba_surfaces') {
    const files = await collectFiles(
      repoRoot,
      [
        'packages/ar-auth/src',
        'packages/ar-management/src',
        'packages/ar-login-ui/src',
        'migrations',
      ],
      new Set(['.ts', '.svelte', '.sql'])
    );
    const forbidden =
      /password[_ -]?hint|security[_ -]?question|secret[_ -]?question|knowledge[_ -]?based authentication|mother'?s?[_ -]?maiden|maiden[_ -]?name/i;

    for (const file of files) {
      const content = await readText(repoRoot, file);
      forbidPattern(content, forbidden, `${file} must not expose password hints or KBA`);
    }

    return {
      id,
      result: 'pass',
      description:
        'Auth runtime, management API, login UI, and migrations expose no password-hint or knowledge-based authentication surfaces.',
      evidence: `${files.length} runtime/schema files scanned`,
    };
  }

  if (id === 'asvs.v7_2_1.backend_session_verification') {
    const directAuth = await readText(repoRoot, 'packages/ar-auth/src/direct-auth.ts');
    const sessionStore = await readText(
      repoRoot,
      'packages/ar-lib-core/src/durable-objects/SessionStore.ts'
    );
    requirePattern(
      directAuth,
      /isShardedSessionId\(sessionId\)/,
      'Runtime session validation must reject non-sharded session IDs.'
    );
    requirePattern(
      directAuth,
      /getSessionStoreBySessionId\(\s*c\.env,\s*sessionId,\s*getTenantIdFromContext\(c\)\s*\)/,
      'Runtime session validation must route verification to backend SessionStore.'
    );
    requirePattern(
      directAuth,
      /sessionStore\.getSessionRpc\(sessionId\)/,
      'Runtime session validation must fetch session state from backend SessionStore.'
    );
    requirePattern(
      directAuth,
      /session\.expiresAt\s*<=\s*Date\.now\(\)/,
      'Runtime session validation must enforce expiration.'
    );
    requirePattern(
      sessionStore,
      /async getSession\(sessionId: string\): Promise<Session \| null>/,
      'SessionStore must expose backend session lookup.'
    );
    requirePattern(
      sessionStore,
      /isRevokedByUserEpoch\(session\)/,
      'SessionStore lookup must enforce user-level revocation epochs.'
    );
    requirePattern(
      sessionStore,
      /isExpired\(session\)/,
      'SessionStore lookup must enforce server-side expiration.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Session tokens are verified through backend SessionStore lookup with format, expiry, and revocation checks.',
      evidence:
        'packages/ar-auth/src/direct-auth.ts; packages/ar-lib-core/src/durable-objects/SessionStore.ts',
    };
  }

  if (id === 'asvs.v7_2_2.dynamic_reference_session_tokens') {
    const sessionHelper = await readText(
      repoRoot,
      'packages/ar-lib-core/src/utils/session-helper.ts'
    );
    const directAuth = await readText(repoRoot, 'packages/ar-auth/src/direct-auth.ts');
    const emailCode = await readText(repoRoot, 'packages/ar-auth/src/email-code.ts');
    const anonLogin = await readText(repoRoot, 'packages/ar-auth/src/anon-login.ts');
    const directoryPassword = await readText(
      repoRoot,
      'packages/ar-auth/src/directory-password-login.ts'
    );
    requirePattern(
      sessionHelper,
      /generateRegionShardedSessionId/,
      'Session helper must generate region-sharded reference tokens.'
    );
    requirePattern(
      sessionHelper,
      /getSessionStoreForNewSession/,
      'New sessions must be issued through the SessionStore helper.'
    );
    requirePattern(
      sessionHelper,
      /getRegionAwareDOStub/,
      'Reference tokens must route to backend Durable Object state.'
    );
    for (const [file, content] of [
      ['packages/ar-auth/src/direct-auth.ts', directAuth],
      ['packages/ar-auth/src/email-code.ts', emailCode],
      ['packages/ar-auth/src/anon-login.ts', anonLogin],
      ['packages/ar-auth/src/directory-password-login.ts', directoryPassword],
    ]) {
      requirePattern(
        content,
        /getSessionStoreForNewSession/,
        `${file} must create runtime sessions through getSessionStoreForNewSession.`
      );
      forbidPattern(
        content,
        /authrim_session['"][\s\S]{0,220}(?:API[_-]?KEY|SECRET|static|hardcoded)/i,
        `${file} must not use static secrets as session tokens`
      );
    }

    return {
      id,
      result: 'pass',
      description:
        'Authentication handlers create dynamic reference session tokens through the SessionStore sharding helper instead of static API secrets or keys.',
      evidence:
        'packages/ar-lib-core/src/utils/session-helper.ts; packages/ar-auth/src/direct-auth.ts; packages/ar-auth/src/email-code.ts; packages/ar-auth/src/anon-login.ts; packages/ar-auth/src/directory-password-login.ts',
    };
  }

  if (id === 'asvs.v7_2_3.session_token_entropy') {
    const sessionHelper = await readText(
      repoRoot,
      'packages/ar-lib-core/src/utils/session-helper.ts'
    );
    const cryptoUtils = await readText(repoRoot, 'packages/ar-lib-core/src/utils/crypto.ts');
    requirePattern(
      sessionHelper,
      /const randomPart = generateSecureSessionId\(\)/,
      'Session IDs must use generateSecureSessionId.'
    );
    requirePattern(
      sessionHelper,
      /`session_\$\{randomPart\}`/,
      'Region-sharded session IDs must embed the generated random part.'
    );
    requirePattern(
      cryptoUtils,
      /const bytes = new Uint8Array\(16\)/,
      'Session token random component must use at least 16 bytes.'
    );
    requirePattern(
      cryptoUtils,
      /crypto\.getRandomValues\(bytes\)/,
      'Session token random component must use CSPRNG.'
    );
    requirePattern(
      cryptoUtils,
      /128 bits/i,
      'Session token entropy must be documented as 128 bits.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Reference session tokens include a 16-byte CSPRNG random component, giving 128 bits of entropy.',
      evidence:
        'packages/ar-lib-core/src/utils/session-helper.ts; packages/ar-lib-core/src/utils/crypto.ts',
    };
  }

  if (id === 'asvs.v7_4_1.logout_and_expiration_invalidate_backend_session') {
    const logout = await readText(repoRoot, 'packages/ar-auth/src/logout.ts');
    const directAuth = await readText(repoRoot, 'packages/ar-auth/src/direct-auth.ts');
    const sessionStore = await readText(
      repoRoot,
      'packages/ar-lib-core/src/durable-objects/SessionStore.ts'
    );
    requirePattern(
      logout,
      /invalidateSessionRpc\(sessionId\)/,
      'Logout must invalidate the cookie session in SessionStore.'
    );
    requirePattern(
      directAuth,
      /invalidateSessionRpc\(sessionId\)/,
      'Direct-auth logout must invalidate the session in SessionStore.'
    );
    requirePattern(
      sessionStore,
      /async invalidateSession\(sessionId: string\): Promise<boolean>/,
      'SessionStore must implement immediate session invalidation.'
    );
    requirePattern(
      sessionStore,
      /this\.sessionCache\.delete\(sessionId\)/,
      'Session invalidation must delete hot cache state.'
    );
    requirePattern(
      sessionStore,
      /this\.actorCtx\.storage\.delete\(storageKey\)/,
      'Session invalidation must delete Durable Object storage state.'
    );
    requirePattern(
      sessionStore,
      /await this\.deleteFromPersistence\(sessionId\)/,
      'Session invalidation must delete cold persistence before returning.'
    );
    requirePattern(
      sessionStore,
      /createTombstone\(sessionId\)/,
      'Session invalidation must protect against stale persistence resurrection.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Logout and session-store invalidation remove backend session state and guard against cold-persistence resurrection.',
      evidence:
        'packages/ar-auth/src/logout.ts; packages/ar-auth/src/direct-auth.ts; packages/ar-lib-core/src/durable-objects/SessionStore.ts',
    };
  }

  if (id === 'asvs.v10_4_1.redirect_uri_exact_allowlist') {
    const authorize = await readText(repoRoot, 'packages/ar-auth/src/authorize.ts');
    const token = await readText(repoRoot, 'packages/ar-token/src/token.ts');
    const validation = await readText(repoRoot, 'packages/ar-lib-core/src/utils/validation.ts');
    requirePattern(
      authorize,
      /validateRedirectUri\(redirect_uri,\s*allowHttp\)/,
      'Authorization endpoint must validate redirect_uri format.'
    );
    requirePattern(
      authorize,
      /isRedirectUriRegistered\(\s*redirect_uri as string,\s*registeredRedirectUris\s*\)/,
      'Authorization endpoint must require registered redirect_uri.'
    );
    requirePattern(
      token,
      /authCodeData\.redirect_uri !== redirect_uri/,
      'Token endpoint must bind authorization code redemption to the original redirect_uri.'
    );
    requirePattern(
      validation,
      /registeredUris\.some\(\(registeredUri\) => registeredUri === providedUri\)/,
      'Registered redirect_uri comparison must be exact string comparison.'
    );
    requirePattern(
      validation,
      /redirect_uri must not contain a fragment/,
      'redirect_uri validation must reject fragments.'
    );

    return {
      id,
      result: 'pass',
      description:
        'OAuth redirect URIs are format-validated, require exact registration matches, and are rebound during authorization-code redemption.',
      evidence:
        'packages/ar-auth/src/authorize.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/utils/validation.ts',
    };
  }

  if (id === 'asvs.v10_4_2.authorization_code_single_use_and_expiry') {
    const token = await readText(repoRoot, 'packages/ar-token/src/token.ts');
    const authCodeStore = await readText(
      repoRoot,
      'packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts'
    );
    const oauthConfig = await readText(repoRoot, 'packages/ar-lib-core/src/utils/oauth-config.ts');
    requirePattern(
      authCodeStore,
      /this\.CODE_TTL = codeTtlEnv[\s\S]{0,120}: 60;/,
      'Authorization code default TTL must be 60 seconds.'
    );
    requirePattern(
      oauthConfig,
      /AUTH_CODE_TTL: 60/,
      'OAuth config default auth-code TTL must be 60 seconds.'
    );
    requirePattern(
      authCodeStore,
      /used: false,[\s\S]{0,120}expiresAt: now \+ this\.CODE_TTL \* 1000/,
      'Stored authorization codes must include used=false and an expiration timestamp.'
    );
    requirePattern(
      authCodeStore,
      /if \(stored\.used\)/,
      'AuthorizationCodeStore must detect reused authorization codes.'
    );
    requirePattern(
      authCodeStore,
      /stored\.used = true/,
      'AuthorizationCodeStore must atomically mark authorization codes as used.'
    );
    requirePattern(
      token,
      /consumedData\.replayAttack/,
      'Token endpoint must handle authorization-code replay detection.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Authorization codes are short-lived, atomically marked used, and replay attempts trigger invalid_grant handling with token revocation where possible.',
      evidence:
        'packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/utils/oauth-config.ts',
    };
  }

  if (id === 'asvs.v10_4_3.redirect_uri_and_pkce_bound_codes') {
    const authorize = await readText(repoRoot, 'packages/ar-auth/src/authorize.ts');
    const token = await readText(repoRoot, 'packages/ar-token/src/token.ts');
    const authCodeStore = await readText(
      repoRoot,
      'packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts'
    );
    requirePattern(
      authorize,
      /redirectUri: validRedirectUri/,
      'Authorization code storage must include the validated redirect_uri.'
    );
    requirePattern(
      authorize,
      /codeChallenge: code_challenge/,
      'Authorization code storage must include code_challenge.'
    );
    requirePattern(
      authorize,
      /PKCE with S256 is required for this client/,
      'Authorization endpoint must require PKCE S256 for public or PKCE-required clients.'
    );
    requirePattern(
      token,
      /authCodeData\.redirect_uri !== redirect_uri/,
      'Token endpoint must compare redirect_uri with the authorization-code binding.'
    );
    requirePattern(
      authCodeStore,
      /if \(stored\.codeChallenge\)/,
      'AuthorizationCodeStore must enforce PKCE when a code challenge is present.'
    );
    requirePattern(
      authCodeStore,
      /challenge !== stored\.codeChallenge/,
      'AuthorizationCodeStore must reject mismatched PKCE verifiers.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Authorization codes bind redirect_uri and PKCE challenge data, and token redemption verifies both bindings.',
      evidence:
        'packages/ar-auth/src/authorize.ts; packages/ar-token/src/token.ts; packages/ar-lib-core/src/durable-objects/AuthorizationCodeStore.ts',
    };
  }

  if (id === 'asvs.v10_4_5.public_refresh_token_replay_protection') {
    const token = await readText(repoRoot, 'packages/ar-token/src/token.ts');
    const rotator = await readText(
      repoRoot,
      'packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts'
    );
    const oauthConfig = await readText(repoRoot, 'packages/ar-lib-core/src/utils/oauth-config.ts');
    requirePattern(
      token,
      /Public client refresh tokens must be DPoP-bound/,
      'Public client refresh tokens must require sender constraint.'
    );
    requirePattern(
      token,
      /DPoP proof JWK does not match refresh token binding/,
      'Refresh token grant must verify DPoP binding.'
    );
    requirePattern(
      token,
      /const rotationEnabled = c\.env\.ENABLE_REFRESH_TOKEN_ROTATION !== 'false'/,
      'Refresh token rotation must be enabled by default.'
    );
    requirePattern(
      token,
      /rotator\.rotateRpc/,
      'Refresh token grant must use RefreshTokenRotator.'
    );
    requirePattern(
      token,
      /Token theft detected and family revoked/,
      'Refresh token replay/theft detection must revoke the token family.'
    );
    requirePattern(
      oauthConfig,
      /REFRESH_TOKEN_ROTATION_ENABLED: true/,
      'OAuth config must default refresh token rotation to enabled.'
    );
    requirePattern(
      rotator,
      /version mismatch|theft|revoked/i,
      'RefreshTokenRotator must detect stale/replayed token families.'
    );

    return {
      id,
      result: 'pass',
      description:
        'Public-client refresh tokens are sender-constrained with DPoP, rotated by default, and stale-token replay revokes the token family.',
      evidence:
        'packages/ar-token/src/token.ts; packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts; packages/ar-lib-core/src/utils/oauth-config.ts',
    };
  }

  throw new Error(`Unknown independent ASVS check: ${id}`);
}

async function runIndependentChecks(repoRoot, controls) {
  const checkIds = [
    ...new Set(
      controls.flatMap((control) =>
        (control.evidence ?? []).map((evidence) => evidence.check).filter(Boolean)
      )
    ),
  ].sort();
  const results = new Map();

  for (const id of checkIds) {
    try {
      results.set(id, await runIndependentCheck(repoRoot, id));
    } catch (error) {
      results.set(id, {
        id,
        result: 'fail',
        description: error instanceof Error ? error.message : String(error),
        evidence: 'independent ASVS check failed',
      });
    }
  }

  return results;
}

function parseArgs(argv) {
  const args = {
    ledger: DEFAULT_LEDGER,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    markdownOutput: undefined,
    reportRoot: DEFAULT_REPORT_ROOT,
    month: undefined,
    enforceNoGaps: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ledger') {
      args.ledger = argv[++index];
    } else if (arg === '--json-output') {
      args.jsonOutput = argv[++index];
    } else if (arg === '--markdown-output') {
      args.markdownOutput = argv[++index];
    } else if (arg === '--report-root') {
      args.reportRoot = argv[++index];
    } else if (arg === '--month') {
      args.month = argv[++index];
    } else if (arg === '--enforce-no-gaps') {
      args.enforceNoGaps = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function resolveReportPaths(repoRoot, args) {
  const month = args.month ?? currentMonth();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Invalid --month value: ${month}. Expected YYYY-MM.`);
  }

  const reportRoot = path.resolve(repoRoot, args.reportRoot);
  const reportDir = path.join(reportRoot, month);
  return {
    month,
    reportRoot,
    markdownOutput: path.resolve(
      repoRoot,
      args.markdownOutput ?? path.join(args.reportRoot, month, 'asvs-coverage.md')
    ),
    jsonOutput: path.resolve(repoRoot, args.jsonOutput),
    indexOutput: path.join(reportRoot, 'README.md'),
    reportDir,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortedMissing(expected, actual) {
  const actualSet = new Set(actual);
  return expected.filter((item) => !actualSet.has(item));
}

function sortedUnexpected(expected, actual) {
  const expectedSet = new Set(expected);
  return actual.filter((item) => !expectedSet.has(item)).sort();
}

function increment(summary, status) {
  summary[status] = (summary[status] ?? 0) + 1;
}

function compareControlIds(left, right) {
  const leftParts = shortRequirementId(left.id).match(/^V(\d+)\.(\d+)\.(\d+)$/);
  const rightParts = shortRequirementId(right.id).match(/^V(\d+)\.(\d+)\.(\d+)$/);
  if (!leftParts || !rightParts) {
    return String(left.id).localeCompare(String(right.id));
  }

  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(leftParts[index]) - Number(rightParts[index]);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function validateLedger(ledger, repoRoot) {
  const errors = [];
  const warnings = [];

  if (String(ledger.asvs_version) !== EXPECTED_ASVS_VERSION) {
    errors.push(`Expected asvs_version ${EXPECTED_ASVS_VERSION}, found ${ledger.asvs_version}.`);
  }
  if (ledger.scope?.level !== EXPECTED_LEVEL) {
    errors.push(`Expected scope.level ${EXPECTED_LEVEL}, found ${ledger.scope?.level}.`);
  }

  const controls = Array.isArray(ledger.controls) ? ledger.controls : [];
  if (controls.length === 0) {
    errors.push('Ledger must contain at least one control.');
  }

  const ids = controls.map((control) => control.id).filter(Boolean);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates)) {
    errors.push(`Duplicate control id: ${id}.`);
  }

  for (const id of sortedMissing(EXPECTED_CONTROL_IDS, ids)) {
    errors.push(`Missing required ASVS control for initial scope: ${id}.`);
  }
  for (const id of sortedUnexpected(EXPECTED_CONTROL_IDS, ids)) {
    errors.push(`Unexpected ASVS control for initial V6/V7/V10.4 L1 scope: ${id}.`);
  }

  for (const control of controls) {
    const prefix = control.id || '<missing id>';
    if (!EXPECTED_CONTROL_IDS.includes(control.id)) {
      continue;
    }
    if (!STATUSES.includes(control.status)) {
      errors.push(`${prefix}: status must be one of ${STATUSES.join(', ')}.`);
    }
    if (control.level !== EXPECTED_LEVEL) {
      errors.push(`${prefix}: expected level ${EXPECTED_LEVEL}, found ${control.level}.`);
    }
    if (!EXPECTED_CHAPTERS.has(control.chapter)) {
      errors.push(`${prefix}: expected chapter V6, V7, or V10, found ${control.chapter}.`);
    }
    if (typeof control.requirement !== 'string' || control.requirement.trim() === '') {
      errors.push(`${prefix}: requirement must be present.`);
    }
    if (typeof control.rationale !== 'string' || control.rationale.trim() === '') {
      errors.push(`${prefix}: rationale must be present.`);
    }
    const evidence = Array.isArray(control.evidence) ? control.evidence : [];
    if (control.status === 'covered' && !Array.isArray(control.evidence)) {
      errors.push(`${prefix}: covered controls must include evidence.`);
    }
    if (control.status === 'covered' && evidence.length === 0) {
      errors.push(`${prefix}: covered controls must include at least one evidence item.`);
    }
    if (control.status === 'manual') {
      warnings.push(
        `${prefix}: manual review remains before this can be counted as evidence covered.`
      );
    }
    if (control.status === 'gap' && !control.remediation) {
      errors.push(`${prefix}: gap controls must include remediation.`);
    }

    for (const [index, evidence] of Object.entries(control.evidence ?? [])) {
      if (!evidence.path && !evidence.check) {
        errors.push(`${prefix}: evidence[${index}].path or evidence[${index}].check is required.`);
        continue;
      }
      if (evidence.path) {
        const evidencePath = path.resolve(repoRoot, evidence.path);
        if (!evidencePath.startsWith(`${repoRoot}${path.sep}`)) {
          errors.push(`${prefix}: evidence path escapes repository: ${evidence.path}.`);
        }
      }
      if (
        typeof evidence.line !== 'undefined' &&
        (!Number.isInteger(evidence.line) || evidence.line < 1)
      ) {
        errors.push(`${prefix}: evidence[${index}].line must be a positive integer.`);
      }
    }
  }

  return { errors, warnings };
}

async function validateEvidenceFiles(controls, repoRoot) {
  const errors = [];
  for (const control of controls) {
    for (const [index, evidence] of Object.entries(control.evidence ?? [])) {
      if (!evidence.path) continue;
      const evidencePath = path.resolve(repoRoot, evidence.path);
      if (!(await pathExists(evidencePath))) {
        errors.push(`${control.id}: evidence[${index}] file does not exist: ${evidence.path}.`);
      }
    }
  }
  return errors;
}

function buildReport(ledger, warnings, independentChecks, month) {
  const controls = [...ledger.controls].sort(compareControlIds);
  const summary = {
    total: controls.length,
    covered: 0,
    manual: 0,
    not_applicable: 0,
    gap: 0,
  };

  for (const control of controls) {
    increment(summary, control.status);
  }

  const applicableTotal = summary.total - summary.not_applicable;
  const applicableCoveredPct =
    applicableTotal > 0 ? Number(((summary.covered / applicableTotal) * 100).toFixed(2)) : 100;
  const totalCoveredPct =
    summary.total > 0 ? Number(((summary.covered / summary.total) * 100).toFixed(2)) : 100;

  return {
    generated_at: new Date().toISOString(),
    report_month: month,
    standard: {
      name: 'OWASP ASVS',
      version: String(ledger.asvs_version),
      level: ledger.scope.level,
      scope: ledger.scope.description,
      source_url: ledger.source_url,
    },
    summary: {
      ...summary,
      applicable_total: applicableTotal,
      applicable_covered_pct: applicableCoveredPct,
      total_covered_pct: totalCoveredPct,
    },
    warnings,
    controls: controls.map((control) => ({
      id: control.id,
      req_id: shortRequirementId(control.id),
      title: control.title,
      section: control.section,
      section_name: SECTION_NAMES.get(control.section) ?? control.title,
      status: control.status,
      result: displayResult(control.status),
      rationale: control.rationale,
      requirement: control.requirement,
      evidence_count: control.evidence?.length ?? 0,
      test_ids: (control.evidence ?? []).map((_, index) => testIdFor(control.id, index)),
    })),
    tests: controls.flatMap((control) =>
      (control.evidence ?? []).map((evidence, index) => {
        const independentCheck = evidence.check ? independentChecks.get(evidence.check) : null;
        const evidenceLocation =
          independentCheck?.evidence ??
          (evidence.line && evidence.path ? `${evidence.path}:${evidence.line}` : evidence.path);
        return {
          id: testIdFor(control.id, index),
          req_id: shortRequirementId(control.id),
          result: independentCheck
            ? independentCheck.result === 'pass'
              ? 'Evidence check passed'
              : 'Evidence check failed'
            : 'Reference',
          description: independentCheck?.description ?? evidence.note ?? control.rationale,
          evidence: evidenceLocation,
        };
      })
    ),
  };
}

function buildMarkdown(report) {
  const byStatus = (status) => report.controls.filter((control) => control.status === status);
  const gapRows =
    byStatus('gap')
      .map((control) => [
        escapeMarkdownTable(control.req_id),
        escapeMarkdownTable(control.section_name),
        escapeMarkdownTable(control.title),
        escapeMarkdownTable(control.rationale),
      ])
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n') || '| - | - | - | - |';
  const manualRows =
    byStatus('manual')
      .map((control) => [
        escapeMarkdownTable(control.req_id),
        escapeMarkdownTable(control.section_name),
        escapeMarkdownTable(control.title),
        escapeMarkdownTable(control.rationale),
      ])
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n') || '| - | - | - | - |';
  const chapterSummaryRows = [
    ...new Set(
      report.controls.map((control) => control.section[0] + control.section.slice(1).split('.')[0])
    ),
  ]
    .map((chapter) => {
      const controls = report.controls.filter((control) => control.id.includes(`-${chapter}.`));
      const covered = controls.filter((control) => control.status === 'covered').length;
      const manual = controls.filter((control) => control.status === 'manual').length;
      const notApplicable = controls.filter(
        (control) => control.status === 'not_applicable'
      ).length;
      const gaps = controls.filter((control) => control.status === 'gap').length;
      return `| ${chapter} | ${controls.length} | ${covered} | ${manual} | ${notApplicable} | ${gaps} |`;
    })
    .join('\n');
  const summaryRows = report.controls
    .map((control) =>
      [control.id, control.result, control.evidence_count, escapeMarkdownTable(control.title)].join(
        ' | '
      )
    )
    .map((row) => `| ${row} |`)
    .join('\n');
  const matrixRows = report.controls
    .map((control) => {
      const tests = control.test_ids.map((id) => `test ${id}`).join(', ');
      return [
        escapeMarkdownTable(control.section_name),
        escapeMarkdownTable(control.req_id),
        escapeMarkdownTable(control.result),
        escapeMarkdownTable(`${tests}: ${control.rationale}`),
        escapeMarkdownTable(control.requirement),
      ];
    })
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
  const testRows = report.tests
    .map((test) => [
      escapeMarkdownTable(test.id),
      escapeMarkdownTable(test.req_id),
      escapeMarkdownTable(test.result),
      escapeMarkdownTable(test.description),
      escapeMarkdownTable(test.evidence),
    ])
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');

  return `# ASVS Monthly Coverage Report - ${report.report_month}

OWASP ASVS v${report.standard.version} Level ${report.standard.level}

Source: ${report.standard.source_url}

Scope: ${report.standard.scope}

Assessment basis: This is an Authrim self-assessment report. It records evidence coverage for the
listed OWASP ASVS requirements and is not a third-party audit, certification, or penetration-test
attestation.

Generated at: ${report.generated_at}

## Table of Contents

- [Executive Summary](#executive-summary)
- [Status by Chapter](#status-by-chapter)
- [Open Gaps](#open-gaps)
- [Manual Review](#manual-review)
- [Control Summary](#control-summary)
- [Requirement Coverage Matrix](#requirement-coverage-matrix)
- [Referenced Tests and Checks](#referenced-tests-and-checks)

## Executive Summary

| Metric | Value |
| --- | ---: |
| Controls | ${report.summary.total} |
| Applicable controls | ${report.summary.applicable_total} |
| Evidence covered | ${report.summary.covered} |
| Manual review | ${report.summary.manual} |
| Not applicable | ${report.summary.not_applicable} |
| Gaps | ${report.summary.gap} |
| Applicable coverage | ${report.summary.applicable_covered_pct}% |
| Total coverage | ${report.summary.total_covered_pct}% |

## Status by Chapter

| Chapter | Controls | Evidence covered | Manual | N/A | Gaps |
| --- | ---: | ---: | ---: | ---: | ---: |
${chapterSummaryRows}

## Open Gaps

| req_id | section_name | Title | Current assessment |
| --- | --- | --- | --- |
${gapRows}

## Manual Review

| req_id | section_name | Title | Current assessment |
| --- | --- | --- | --- |
${manualRows}

## Control Summary

| Control | Status | Evidence | Title |
| --- | --- | ---: | --- |
${summaryRows}

## Requirement Coverage Matrix

| section_name | req_id | Result | Description | Requirement |
| --- | --- | --- | --- | --- |
${matrixRows}

## Referenced Tests and Checks

| Test ID | req_id | Result | Description | Evidence |
| --- | --- | --- | --- | --- |
${testRows}
`;
}

async function buildReportIndex(reportRoot, currentMonth) {
  let entries = [];
  try {
    const dirEntries = await fs.readdir(reportRoot, { withFileTypes: true });
    entries = dirEntries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    entries = [];
  }

  if (!entries.includes(currentMonth)) {
    entries.unshift(currentMonth);
  }

  const rows = entries
    .map((month) => `| ${month} | [ASVS coverage](./${month}/asvs-coverage.md) |`)
    .join('\n');

  return `# ASVS Reports

Monthly ASVS review reports generated by \`pnpm run asvs:check\`.

## Reports

| Month | Report |
| --- | --- |
${rows}
`;
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function writeText(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const reportPaths = resolveReportPaths(repoRoot, args);
  const ledgerPath = path.resolve(repoRoot, args.ledger);
  const ledgerRaw = await fs.readFile(ledgerPath, 'utf8');
  const ledger = YAML.parse(ledgerRaw);

  const validation = validateLedger(ledger, repoRoot);
  validation.errors.push(...(await validateEvidenceFiles(ledger.controls ?? [], repoRoot)));
  const independentChecks = await runIndependentChecks(repoRoot, ledger.controls ?? []);
  for (const check of independentChecks.values()) {
    if (check.result !== 'pass') {
      validation.errors.push(`${check.id}: ${check.description}`);
    }
  }

  const report = buildReport(ledger, validation.warnings, independentChecks, reportPaths.month);
  await writeJson(reportPaths.jsonOutput, report);
  await writeText(reportPaths.markdownOutput, buildMarkdown(report));
  await writeText(
    reportPaths.indexOutput,
    await buildReportIndex(reportPaths.reportRoot, reportPaths.month)
  );

  for (const warning of validation.warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (args.enforceNoGaps && report.summary.gap > 0) {
    validation.errors.push(`ASVS coverage has ${report.summary.gap} gap(s).`);
  }

  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      console.error(`error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `ASVS coverage: ${report.summary.covered}/${report.summary.total} evidence covered, ` +
      `${report.summary.manual} manual, ${report.summary.not_applicable} not applicable, ` +
      `${report.summary.gap} gaps. Report: ${path.relative(repoRoot, reportPaths.markdownOutput)}`
  );
}

await main();
