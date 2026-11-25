import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  inventoryCoreAuditWrites,
  inventorySystemEventWrites,
  type AuditWriteSite,
} from './helpers/core-audit-inventory';

/**
 * Events of the platform itself (a cron, an outbox, a delivery: no administrator and no end
 * user behind them) belong in the system log (`logSystemEvent`, `runtime.system_events`), not in
 * the end-user event log. A core write whose actor is the platform, or is not a literal, and
 * that does not name the end user it is about, must be one of the writes listed here with the
 * reason it stays: a user's own flow, a user it is about in another field, an admin operation
 * that moves separately, or the dispatcher's generic path. A new such write fails this test
 * until it is moved to the system log or listed with its reason.
 */

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const coreSites = inventoryCoreAuditWrites(repositoryRoot);
const systemSites = inventorySystemEventWrites(repositoryRoot);

type Reason =
  /** Part of a user's sign-in, session, token or consent flow; the user is in the row's other fields. */
  | 'user_flow'
  /** About one end user (its resource ID or metadata names the user in a way the inventory does not read). */
  | 'user_target'
  /** An administrator's operation: moves to the admin audit log in its own change. */
  | 'admin_operation'
  /** A client's own operation on itself (a registration access token), not an administrator's. */
  | 'client_operation'
  /** The event dispatcher's generic record of a published event; the publishers are user flows and admin routes. */
  | 'dispatcher'
  /** A security event about a request, kept with the end-user log's SIEM delivery and fail-closed class. */
  | 'security';

/**
 * `<file> <action>` of every core write kept out of the system log on purpose, with its reason
 * and how many calls there are (a call added or removed under the same name is a change too).
 */
const KEPT: Readonly<Record<string, [Reason, number]>> = {
  // Sign-in, sign-out and session: the user's own flow.
  'packages/ar-auth/src/did-auth.ts user.login': ['user_flow', 1],
  'packages/ar-auth/src/direct-auth.ts user.logout': ['user_flow', 1],
  'packages/ar-auth/src/directory-password-login.ts user.login': ['user_flow', 2],
  'packages/ar-auth/src/email-code.ts auth.email_code.send_failed': ['user_flow', 1],
  'packages/ar-auth/src/email-code.ts user.login': ['user_flow', 1],
  'packages/ar-auth/src/guest-login.ts user.login': ['user_flow', 1],
  'packages/ar-auth/src/logout.ts user.logout': ['user_flow', 2],
  'packages/ar-auth/src/logout.ts backchannel_logout.failed': ['user_flow', 1],
  'packages/ar-auth/src/passkey.ts user.login': ['user_flow', 1],
  'packages/ar-auth/src/totp.ts user.login': ['user_flow', 2],
  'packages/ar-bridge/src/handlers/backchannel-logout.ts user.logout': ['user_flow', 1],
  'packages/ar-bridge/src/handlers/backchannel-logout.ts backchannel_logout.failed': [
    'user_flow',
    1,
  ],
  'packages/ar-saml/src/sp/acs.ts user.login': ['user_flow', 1],
  'packages/ar-management/src/session-end-logout.ts user.logout': ['user_flow', 1],
  'packages/ar-management/src/session-end-logout.ts backchannel_logout.failed': ['user_flow', 1],
  'packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts refresh_token.*': [
    'user_flow',
    1,
  ],
  'packages/ar-lib-core/src/durable-objects/RefreshTokenRotator.ts dynamic:action': [
    'user_flow',
    1,
  ],
  // About one user: a provider's notice about the user's account, a linked identity, the
  // user's downstream sign-out, the user's account creation or erasure, a SAML logout
  // transaction of the user's session.
  'packages/ar-bridge/src/handlers/facebook-data-deletion.ts dynamic:AUDIT_ACTIONS[input.kind]': [
    'user_target',
    1,
  ],
  'packages/ar-bridge/src/services/identity-stitching.ts dynamic:params.action': ['user_target', 1],
  'packages/ar-bridge/src/services/link-intent.ts dynamic:action': ['user_target', 1],
  'packages/ar-lib-core/src/services/logout-fanout.ts user.downstream_logout_failed': [
    'user_target',
    2,
  ],
  'packages/ar-management/src/account-directory-producer.ts account.creation_refused': [
    'user_target',
    1,
  ],
  'packages/ar-management/src/account-identifier-erasure.ts identifier_values.retirement_skipped': [
    'user_target',
    1,
  ],
  'packages/ar-management/src/account-operation-log.ts dynamic:input.action': ['user_target', 1],
  'packages/ar-management/src/identifier-replacement-scheduled.ts account.email.changed': [
    'user_target',
    1,
  ],
  'packages/ar-saml/src/scheduled.ts saml.logout_fanout.timeout': ['user_target', 1],
  // Administrators' operations, recorded by older code in the end-user log.
  'packages/ar-lib-core/src/vc/wallet-allowlist.ts dynamic:action': ['admin_operation', 1],
  'packages/ar-management/src/admin-job-executor.ts dynamic:action': ['admin_operation', 1],
  'packages/ar-saml/src/admin/providers.ts dynamic:input.action': ['admin_operation', 1],
  // A client changing or deleting its own registration with its registration access token.
  'packages/ar-management/src/client-config.ts client.config.updated': ['client_operation', 1],
  'packages/ar-management/src/client-config.ts client.config.deleted': ['client_operation', 1],
  // The dispatcher records what was published; no publisher names a system actor.
  'packages/ar-lib-core/src/services/event-dispatcher.ts dynamic:event.type': ['dispatcher', 1],
  'packages/ar-lib-core/src/utils/event-dispatcher-factory.ts dynamic:event.type': [
    'dispatcher',
    1,
  ],
};

/** The writes that moved to the system log: where, from which source, which action. */
const MOVED: ReadonlyArray<{ file: string; source: string; actions: readonly string[] }> = [
  {
    file: 'packages/ar-management/src/account-webhook-outbox.ts',
    // The entry is built by `droppedSystemEvent`, so the call's argument is a variable.
    source: 'dynamic:entry',
    actions: ['dynamic:entry'],
  },
  {
    file: 'packages/ar-auth/src/directory-connector-heartbeat.ts',
    source: 'authrim/directory_connector_heartbeat',
    actions: ['directory_connector_heartbeat.failed'],
  },
  {
    file: 'packages/ar-saml/src/admin/metadata-polling.ts',
    source: 'authrim/saml_metadata_scheduler',
    actions: [
      "dynamic:input.errorCode ? 'saml.provider.metadata_refresh_failed' : 'saml.provider.metadata_refreshed'",
      'saml.federation.metadata_refreshed',
    ],
  },
];

const key = (site: AuditWriteSite) => `${site.file} ${site.action}`;
/** A write the platform may have made without naming the user it is about. */
const systemOrUnknownActor = (site: AuditWriteSite) =>
  site.actorSystem !== false && !site.namesUser;

describe('system-origin writes to the end-user log', () => {
  /** How many such writes each `<file> <action>` has now. */
  const counts = new Map<string, number>();
  for (const site of coreSites.filter(systemOrUnknownActor)) {
    counts.set(key(site), (counts.get(key(site)) ?? 0) + 1);
  }

  it('lists every core write whose actor may be the platform and that names no user, and how many', () => {
    const unlisted = coreSites.filter((site) => systemOrUnknownActor(site) && !(key(site) in KEPT));
    expect(unlisted.map((site) => `${key(site)} (${site.file}:${site.line})`)).toEqual([]);
    const miscounted = [...counts].filter(([entry, n]) => KEPT[entry] && KEPT[entry][1] !== n);
    expect(miscounted.map(([entry, n]) => `${entry}: ${n} (listed ${KEPT[entry][1]})`)).toEqual([]);
  });

  it('lists nothing that no longer exists, and nothing that names its user or is an admin write', () => {
    expect(Object.keys(KEPT).filter((entry) => !counts.has(entry))).toEqual([]);
  });

  it('writes the moved events to the system log, from their sources', () => {
    for (const moved of MOVED) {
      const sites = systemSites.filter((site) => site.file === moved.file);
      expect(
        sites.map((site) => site.source),
        moved.file
      ).toEqual(moved.actions.map(() => moved.source));
      expect(
        sites.map((site) => site.action),
        moved.file
      ).toEqual([...moved.actions]);
    }
    expect(systemSites).toHaveLength(MOVED.reduce((n, moved) => n + moved.actions.length, 0));
  });

  it('writes the moved actions nowhere in the end-user log any more', () => {
    const movedActions = [
      'webhook.outbox.dropped',
      'directory_connector_heartbeat.failed',
      'saml.provider.metadata_refreshed',
      'saml.provider.metadata_refresh_failed',
    ];
    const stillInCore = coreSites.filter((site) => movedActions.includes(site.action));
    expect(stillInCore.map(key)).toEqual([]);
    // The federation refresh stays in the end-user log for an administrator's manual run only.
    const federation = coreSites.filter(
      (site) => site.action === 'saml.federation.metadata_refreshed'
    );
    expect(federation.map((site) => site.file)).toEqual([
      'packages/ar-saml/src/admin/metadata-polling.ts',
    ]);
  });
});
