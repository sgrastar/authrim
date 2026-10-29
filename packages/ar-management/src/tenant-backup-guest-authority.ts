import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  listGuestPiiDeletionMarkers,
  normalizeGuestPiiDeletedMarker,
  type GuestPiiDeletedMarker,
} from '@authrim/ar-lib-core/services/guest-pii-erasure';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type {
  SqliteDatasetInspectionPolicy,
  PortableSqliteRow,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { phase8RestoreHoldReason } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-holds';
import {
  parseGuestCurrentDenyWitness,
  type GuestCurrentDenyWitness,
} from '@authrim/ar-lib-core/services/tenant-portability/guest-current-deny-witness';

export interface GuestRestoreAuthoritySource {
  environmentId: string;
  issuer: string;
  inventoryDigest: string;
  resources: { id: string; family: 'core' | 'pii'; database: DatabaseAdapter }[];
}
const primary = { consistencyClass: 'primary_required' } as const;
function blocked(): never {
  throw new Error('backup_guest_current_deny_authority_unavailable');
}
async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function parsed(json: string): PortableSqliteRow {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) blocked();
  return value as PortableSqliteRow;
}
function scalar(row: PortableSqliteRow, key: string): string | number | null {
  const cell = row[key];
  if (!Array.isArray(cell) || cell.length !== 2) blocked();
  if (cell[0] === 'null' && cell[1] === null) return null;
  if (cell[0] === 'text' && typeof cell[1] === 'string') return cell[1];
  if (
    cell[0] === 'integer' &&
    typeof cell[1] === 'string' &&
    /^-?\d+$/u.test(cell[1]) &&
    Number.isSafeInteger(Number(cell[1]))
  )
    return Number(cell[1]);
  return blocked();
}
function marker(rowJson: string): GuestPiiDeletedMarker {
  const row = parsed(rowJson);
  return normalizeGuestPiiDeletedMarker(
    Object.fromEntries(Object.keys(row).map((key) => [key, scalar(row, key)]))
  );
}
type Epochs = GuestCurrentDenyWitness['epochs'];
interface PageCursor {
  version: 1;
  witness: GuestCurrentDenyWitness;
  resourceIndex: number;
  afterUserId: string | null;
}

/** Closed internal port. The source resolver must authenticate the *current* complete inventory. */
export function createTenantBackupGuestAuthority(input: {
  source(context: TenantBackupStepContext): Promise<GuestRestoreAuthoritySource>;
  authorize(context: TenantBackupStepContext): Promise<void>;
  save(context: TenantBackupStepContext, witness: GuestCurrentDenyWitness): Promise<void>;
  load(
    context: TenantBackupStepContext,
    planDigest: string,
    assertCurrent: (witness: GuestCurrentDenyWitness) => Promise<void>
  ): Promise<GuestCurrentDenyWitness>;
  apply(
    context: TenantBackupStepContext,
    planDigest: string,
    markers: readonly GuestPiiDeletedMarker[]
  ): Promise<void>;
}) {
  async function current(context: TenantBackupStepContext) {
    await input.authorize(context);
    const source = await input.source(context);
    if (
      !source.resources.length ||
      source.resources.length > 64 ||
      !source.resources.some((value) => value.family === 'core') ||
      !source.resources.some((value) => value.family === 'pii') ||
      new Set(source.resources.map((value) => `${value.family}:${value.id}`)).size !==
        source.resources.length
    )
      blocked();
    source.resources.sort((a, b) =>
      `${a.family}:${a.id}` < `${b.family}:${b.id}`
        ? -1
        : `${a.family}:${a.id}` > `${b.family}:${b.id}`
          ? 1
          : 0
    );
    const epochs: Epochs = [];
    for (const resource of source.resources) {
      const table =
        resource.family === 'core' ? 'guest_core_mutation_epoch' : 'guest_pii_mutation_epoch';
      const before = await resource.database.queryOne<{ revision: number }>(
        `SELECT revision FROM ${table} WHERE id=1`,
        [],
        primary
      );
      if (!before || !Number.isSafeInteger(before.revision) || before.revision < 0) blocked();
      // Accepted+hold is deliberately included: its PII marker does not exist before B.
      const held =
        resource.family === 'core'
          ? await resource.database.queryOne(
              `SELECT 1 AS held FROM guest_account_lifecycle WHERE tenant_id=? AND
            (phase NOT IN ('active','registered','deleted') OR
             (phase='registered' AND (upgrade_finalized_at IS NULL OR upgrade_finalized_at<=0)) OR
             (phase='active' AND (deletion_operation_id IS NOT NULL OR deletion_route_json IS NOT NULL OR deletion_started_at_ms IS NOT NULL OR deleted_at IS NOT NULL))) LIMIT 1`,
              [context.lease.tenantId],
              primary
            )
          : await resource.database.queryOne(
              `SELECT 1 AS held FROM guest_pii_erasure_markers WHERE tenant_id=? AND state='erasing' LIMIT 1`,
              [context.lease.tenantId],
              primary
            );
      if (held) throw new Error('backup_guest_current_source_held');
      const after = await resource.database.queryOne<{ revision: number }>(
        `SELECT revision FROM ${table} WHERE id=1`,
        [],
        primary
      );
      if (after?.revision !== before.revision)
        throw new Error('backup_guest_current_source_changed');
      epochs.push({ family: resource.family, resourceId: resource.id, revision: before.revision });
    }
    await input.authorize(context);
    return { source, epochs };
  }
  function sameSource(
    witness: GuestCurrentDenyWitness,
    observed: Awaited<ReturnType<typeof current>>
  ) {
    if (
      witness.sourceEnvironmentId !== observed.source.environmentId ||
      witness.sourceIssuer !== observed.source.issuer ||
      witness.inventoryDigest !== observed.source.inventoryDigest ||
      JSON.stringify(witness.epochs) !== JSON.stringify(observed.epochs)
    )
      throw new Error('backup_guest_current_source_changed');
  }
  async function assertCurrent(context: TenantBackupStepContext, witness: GuestCurrentDenyWitness) {
    sameSource(witness, await current(context));
  }

  // A bundle cannot prove that its own declaration of a registered user is current. Every
  // human account must have one current positive owner, and no current Guest workflow/deny.
  async function admitRows(
    context: TenantBackupStepContext,
    datasetId: string,
    rows: readonly string[],
    ownerField?: 'user_id' | 'account_id' | 'subject_id' | 'profile_id'
  ) {
    if (!rows.length || rows.length > 500) blocked();
    rows = [...rows];
    const { source, epochs } = await current(context);
    const cores = source.resources.filter((value) => value.family === 'core');
    const piies = source.resources.filter((value) => value.family === 'pii');
    const accounts = rows
      .filter((json) => phase8RestoreHoldReason(datasetId, json) === null)
      .map((json) => ({ json, row: parsed(json) }));
    for (let offset = 0; offset < accounts.length; offset += 40) {
      const group = accounts.slice(offset, offset + 40);
      if (datasetId === 'pii.guest_pii_erasure_markers') {
        const values = group.map(({ json }) => marker(json));
        if (values.some((value) => value.tenant_id !== context.lease.tenantId)) blocked();
        const found = (
          await Promise.all(
            piies.map((resource) =>
              resource.database.query<Record<string, unknown>>(
                `SELECT * FROM guest_pii_erasure_markers WHERE tenant_id=? AND user_id IN (${values.map(() => '?').join(',')})`,
                [context.lease.tenantId, ...values.map((value) => value.user_id)],
                primary
              )
            )
          )
        ).flat();
        for (const value of values) {
          const matches = found.filter((entry) => entry.user_id === value.user_id);
          if (
            matches.length !== 1 ||
            JSON.stringify(normalizeGuestPiiDeletedMarker(matches[0])) !== JSON.stringify(value)
          )
            blocked();
        }
        continue;
      }
      const records = group
        .map((value) => {
          let kind: 'user' | 'account' | 'subject' | 'profile' = 'user';
          let field: string = ownerField ?? 'user_id';
          if (datasetId === 'core.identity_accounts') {
            kind = 'account';
            field = 'id';
          } else if (datasetId === 'pii.users_pii') field = 'id';
          else if (datasetId === 'core.profiles') {
            kind = 'profile';
            field = 'id';
          } else if (
            datasetId === 'pii.identity_sensitive_values' ||
            datasetId === 'core.structured_attribute_values'
          ) {
            const type = scalar(value.row, 'owner_type');
            if (
              ![
                'runtime_user',
                'identity_account',
                'account',
                'identity_subject',
                'subject',
                'profile',
              ].includes(String(type))
            )
              return null;
            kind =
              type === 'runtime_user'
                ? 'user'
                : type === 'profile'
                  ? 'profile'
                  : ['subject', 'identity_subject'].includes(String(type))
                    ? 'subject'
                    : 'account';
            field = 'owner_id';
          } else if (datasetId === 'pii.subject_identifiers') field = 'subject_id';
          else if (datasetId === 'pii.identity_identifier_replacement_history')
            field = 'operation_id';
          else if (datasetId.startsWith('pii.identity_identifier_replacement_'))
            field = 'account_id';
          else if (datasetId === 'core.identity_subjects') {
            kind = 'subject';
            field = 'id';
          } else if (ownerField === 'account_id') {
            kind = 'account';
            if (
              scalar(value.row, 'account_id') === null &&
              Object.hasOwn(value.row, 'subject_id')
            ) {
              kind = 'subject';
              field = 'subject_id';
            }
          } else if (ownerField === 'subject_id') kind = 'subject';
          else if (ownerField === 'profile_id') kind = 'profile';
          const lookup = scalar(value.row, field);
          if (typeof lookup !== 'string' || !lookup) blocked();
          return { ...value, kind, lookup };
        })
        .filter((value): value is NonNullable<typeof value> => value !== null);
      const profiles = records.filter((value) => value.kind === 'profile');
      if (profiles.length) {
        const found = (
          await Promise.all(
            cores.map((resource) =>
              resource.database.query<{
                id: string;
                tenant_id: string;
                subject_id: string;
                profile_type: string;
                lifecycle_state: string;
                deleted_at: number | null;
              }>(
                `SELECT id,tenant_id,subject_id,profile_type,lifecycle_state,deleted_at FROM profiles WHERE tenant_id=? AND id IN (${profiles.map(() => '?').join(',')})`,
                [context.lease.tenantId, ...profiles.map((value) => value.lookup)],
                primary
              )
            )
          )
        ).flat();
        for (const value of profiles) {
          const matches = found.filter((entry) => entry.id === value.lookup);
          if (
            matches.length !== 1 ||
            !matches[0].subject_id ||
            matches[0].lifecycle_state !== 'active' ||
            matches[0].deleted_at !== null
          )
            blocked();
          if (
            datasetId === 'core.profiles' &&
            ['id', 'tenant_id', 'subject_id', 'profile_type', 'lifecycle_state', 'deleted_at'].some(
              (key) => scalar(value.row, key) !== matches[0][key as keyof (typeof matches)[0]]
            )
          )
            blocked();
          value.kind = 'subject';
          value.lookup = matches[0].subject_id;
        }
      }
      if (datasetId === 'pii.identity_identifier_replacement_history') {
        const ids = group.map(({ row }) => scalar(row, 'operation_id'));
        const parents = (
          await Promise.all(
            piies.map((resource) =>
              resource.database.query<{ operation_id: string; account_id: string }>(
                `SELECT operation_id,account_id FROM identity_identifier_replacement_operations WHERE tenant_id=? AND operation_id IN (${ids.map(() => '?').join(',')})`,
                [context.lease.tenantId, ...ids],
                primary
              )
            )
          )
        ).flat();
        records.splice(
          0,
          records.length,
          ...group.map((value) => {
            const matches = parents.filter(
              (parent) => parent.operation_id === scalar(value.row, 'operation_id')
            );
            if (matches.length !== 1) blocked();
            return { ...value, kind: 'user' as const, lookup: matches[0].account_id };
          })
        );
      }
      for (const kind of ['user', 'account', 'subject'] as const) {
        const selected = records.filter((value) => value.kind === kind);
        if (!selected.length) continue;
        const ids = selected.map((value) => value.lookup);
        if (ids.some((value) => typeof value !== 'string' || !value)) blocked();
        const byAccount = kind === 'account';
        const candidates = (
          await Promise.all(
            cores.map((resource) =>
              resource.database.query<Record<string, unknown>>(
                `SELECT a.id,a.tenant_id,a.legacy_user_id,a.primary_subject_id,a.account_type,a.lifecycle_state,a.registration_state,a.account_route_generation,a.deleted_at,a.directory_publication_state,
          g.phase AS guest_phase,g.revision AS guest_revision,g.upgrade_finalized_at
          FROM identity_accounts a LEFT JOIN guest_account_lifecycle g ON g.tenant_id=a.tenant_id AND g.user_id=a.legacy_user_id
          WHERE a.tenant_id=? AND a.${kind === 'subject' ? 'primary_subject_id' : byAccount ? 'id' : 'legacy_user_id'} IN (${ids.map(() => '?').join(',')})`,
                [context.lease.tenantId, ...ids],
                primary
              )
            )
          )
        ).flat();
        const subjects =
          kind === 'subject'
            ? (
                await Promise.all(
                  cores.map((resource) =>
                    resource.database.query<Record<string, unknown>>(
                      `SELECT id,tenant_id,subject_type,lifecycle_state,primary_account_id,deleted_at FROM identity_subjects WHERE tenant_id=? AND id IN (${ids.map(() => '?').join(',')})`,
                      [context.lease.tenantId, ...ids],
                      primary
                    )
                  )
                )
              ).flat()
            : [];
        if (
          ids.some((id) =>
            kind === 'subject'
              ? subjects.filter((value) => value.id === id).length !== 1
              : candidates.filter((value) => (byAccount ? value.id : value.legacy_user_id) === id)
                  .length !== 1
          )
        )
          blocked();
        const userIds = [
          ...new Set(
            candidates
              .map((value) => value.legacy_user_id)
              .filter((value): value is string => typeof value === 'string')
          ),
        ];
        const userIdsJson = JSON.stringify(userIds);
        if (new TextEncoder().encode(userIdsJson).byteLength > 4 * 1024 * 1024) blocked();
        const denied = userIds.length
          ? (
              await Promise.all(
                piies.map((resource) =>
                  resource.database.query<{ user_id: string }>(
                    `SELECT user_id FROM guest_pii_erasure_markers WHERE tenant_id=? AND user_id IN (SELECT value FROM json_each(?) WHERE type='text')`,
                    [context.lease.tenantId, userIdsJson],
                    primary
                  )
                )
              )
            ).flat()
          : [];
        for (const { row, lookup: id } of selected) {
          let owners = candidates.filter(
            (value) =>
              (kind === 'subject'
                ? value.primary_subject_id
                : byAccount
                  ? value.id
                  : value.legacy_user_id) === id
          );
          if (kind === 'subject') {
            const subject = subjects.find((value) => value.id === id) ?? blocked();
            if (subject.lifecycle_state !== 'active' || subject.deleted_at !== null) blocked();
            if (
              datasetId === 'core.identity_subjects' &&
              [
                'id',
                'tenant_id',
                'subject_type',
                'lifecycle_state',
                'primary_account_id',
                'deleted_at',
              ].some((key) => scalar(row, key) !== subject[key])
            )
              blocked();
            // A shared subject survives erasure of one account. Only current active owners
            // can authorize its restore; terminal account history is never recreated here.
            owners = owners.filter(
              (value) => value.lifecycle_state === 'active' && value.deleted_at === null
            );
            if (
              (subject.subject_type === 'person' && !owners.length) ||
              (subject.primary_account_id !== null &&
                !owners.some((value) => value.id === subject.primary_account_id))
            )
              blocked();
          } else if (owners.length !== 1) blocked();
          for (const owner of owners) {
            const terminal =
              (datasetId === 'core.identity_accounts' &&
                scalar(row, 'lifecycle_state') === 'deleted' &&
                owner.lifecycle_state === 'deleted') ||
              (datasetId === 'core.guest_account_lifecycle' &&
                scalar(row, 'phase') === 'deleted' &&
                owner.guest_phase === 'deleted');
            if (
              (!terminal &&
                (owner.deleted_at !== null ||
                  owner.lifecycle_state !== 'active' ||
                  denied.some((value) => value.user_id === owner.legacy_user_id))) ||
              (owner.guest_phase !== null &&
                !(
                  owner.guest_phase === 'active' ||
                  (terminal && owner.guest_phase === 'deleted') ||
                  (owner.guest_phase === 'registered' &&
                    Number.isSafeInteger(owner.upgrade_finalized_at) &&
                    Number(owner.upgrade_finalized_at) > 0)
                ))
            )
              blocked();
            if (
              datasetId === 'core.identity_accounts' &&
              [
                'id',
                'tenant_id',
                'legacy_user_id',
                'account_type',
                'lifecycle_state',
                'registration_state',
                'account_route_generation',
                'deleted_at',
                'directory_publication_state',
              ].some((key) => scalar(row, key) !== owner[key])
            )
              blocked();
            if (
              datasetId === 'core.guest_account_lifecycle' &&
              (scalar(row, 'phase') !== owner.guest_phase ||
                scalar(row, 'revision') !== owner.guest_revision)
            )
              blocked();
            if (
              (datasetId === 'pii.external_identifier_unlink_operations' ||
                (datasetId.startsWith('core.') &&
                  Object.hasOwn(row, 'user_id') &&
                  Object.hasOwn(row, 'account_id'))) &&
              scalar(row, 'account_id') !== null &&
              scalar(row, 'account_id') !== owner.id
            )
              blocked();
          }
        }
      }
    }
    const fresh = await current(context);
    if (
      source.inventoryDigest !== fresh.source.inventoryDigest ||
      JSON.stringify(epochs) !== JSON.stringify(fresh.epochs)
    )
      throw new Error('backup_guest_current_source_changed');
    return fresh;
  }
  function wrap(policies: readonly SqliteDatasetInspectionPolicy[]) {
    const guarded = new Set([
      'core.identity_accounts',
      'core.guest_account_lifecycle',
      'core.identity_subjects',
      'core.passkeys',
      'core.guest_devices',
      'core.totp_credentials',
      'core.totp_backup_codes',
      'pii.users_pii',
      'pii.guest_pii_erasure_markers',
      'pii.identity_sensitive_values',
      'pii.subject_identifiers',
      'pii.identity_identifier_replacement_history',
      'core.structured_attribute_values',
      'core.profile_attribute_values',
    ]);
    return policies.map((policy) => {
      const columns = policy.schema?.columns ?? [];
      const ownerField = columns.includes('user_id')
        ? 'user_id'
        : columns.includes('account_id')
          ? 'account_id'
          : columns.includes('subject_id')
            ? 'subject_id'
            : columns.includes('profile_id')
              ? 'profile_id'
              : undefined;
      if (
        !guarded.has(policy.dataset.id) &&
        !(policy.dataset.kind === 'users' && ownerField && /^(core|pii)\./u.test(policy.dataset.id))
      )
        return policy;
      const base = policy.admitRow,
        transform = policy.restoreTransform;
      let prepared: { context: TenantBackupStepContext; rows: Set<string> } | undefined;
      let restorePrepared:
        | {
            context: TenantBackupStepContext;
            rows: Set<string>;
            baseline: Awaited<ReturnType<typeof current>>;
          }
        | undefined;
      return {
        ...policy,
        ...(policy.dataset.id === 'pii.guest_pii_erasure_markers'
          ? { restoreAllowsAdditionalRows: true, restoreDisposition: 'reference_only' as const }
          : {}),
        admitRow: {
          id: `${base?.id ?? policy.dataset.id}.guest-current-owner-v1`,
          async prepareRows(context: TenantBackupStepContext, rows: readonly string[]) {
            await base?.prepareRows?.(context, rows);
            await admitRows(context, policy.dataset.id, rows, ownerField);
            prepared = { context, rows: new Set(rows) };
          },
          async admit(context: TenantBackupStepContext, rowJson: string) {
            await base?.admit(context, rowJson);
            if (prepared?.context !== context || !prepared.rows.has(rowJson))
              await admitRows(context, policy.dataset.id, [rowJson], ownerField);
          },
        },
        restoreTransform: {
          id: `${transform?.id ?? policy.dataset.id}.guest-current-owner-v1`,
          statementsPerRow: transform?.statementsPerRow ?? 0,
          statementsPerBatch:
            (transform?.statementsPerBatch ?? 0) +
            (['subject_id', 'profile_id'].includes(ownerField ?? '') ||
            [
              'core.identity_subjects',
              'pii.identity_sensitive_values',
              'core.structured_attribute_values',
            ].includes(policy.dataset.id)
              ? 256
              : 128),
          async prepareRows(
            context: TenantBackupStepContext,
            rows: readonly string[],
            mode: 'write' | 'defer' | 'verify'
          ) {
            await transform?.prepareRows?.(context, rows, mode);
            const baseline = await admitRows(context, policy.dataset.id, rows, ownerField);
            restorePrepared = { context, rows: new Set(rows), baseline };
          },
          async assertPreparedRows(context: TenantBackupStepContext) {
            await transform?.assertPreparedRows?.(context);
            if (restorePrepared?.context !== context) blocked();
            const observed = await current(context);
            if (
              observed.source.inventoryDigest !== restorePrepared.baseline.source.inventoryDigest ||
              JSON.stringify(observed.epochs) !== JSON.stringify(restorePrepared.baseline.epochs)
            )
              throw new Error('backup_guest_current_source_changed');
          },
          async transform(
            context: TenantBackupStepContext,
            rowJson: string,
            mode: 'write' | 'defer' | 'verify'
          ) {
            const value = transform ? await transform.transform(context, rowJson, mode) : rowJson;
            if (restorePrepared?.context !== context || !restorePrepared.rows.has(value))
              await admitRows(context, policy.dataset.id, [value], ownerField);
            return value;
          },
        },
      };
    });
  }
  async function page(
    context: TenantBackupStepContext,
    planDigest: string,
    cursorJson: string | null
  ) {
    const observed = await current(context);
    let cursor: PageCursor;
    if (cursorJson === null) {
      cursor = {
        version: 1,
        resourceIndex: 0,
        afterUserId: null,
        witness: {
          version: 1,
          purpose: 'guest-current-deny-v1',
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          planDigest,
          sourceEnvironmentId: observed.source.environmentId,
          sourceIssuer: observed.source.issuer,
          inventoryDigest: observed.source.inventoryDigest,
          epochs: observed.epochs,
          denyDigest: await hash('guest-current-deny-v1'),
          markerCount: 0,
        },
      };
    } else {
      if (cursorJson.length > 24000) blocked();
      const value: unknown = JSON.parse(cursorJson);
      if (!value || typeof value !== 'object' || Array.isArray(value)) blocked();
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'afterUserId,resourceIndex,version,witness' ||
        record.version !== 1 ||
        !Number.isSafeInteger(record.resourceIndex) ||
        Number(record.resourceIndex) < 0 ||
        !(record.afterUserId === null || typeof record.afterUserId === 'string')
      )
        blocked();
      cursor = {
        version: 1,
        resourceIndex: Number(record.resourceIndex),
        afterUserId: record.afterUserId,
        witness: parseGuestCurrentDenyWitness(JSON.stringify(record.witness), {
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          planDigest,
        }),
      };
    }
    if (
      cursor.witness.sourceEnvironmentId !== observed.source.environmentId ||
      cursor.witness.sourceIssuer !== observed.source.issuer ||
      cursor.witness.inventoryDigest !== observed.source.inventoryDigest
    )
      throw new Error('backup_guest_current_source_changed');
    if (JSON.stringify(cursor.witness.epochs) !== JSON.stringify(observed.epochs)) {
      // Keep the reviewed source vector. A retry cannot silently replace its positive
      // ownership/denial proof with a newer source; a changed source requires a new plan.
      throw new Error('backup_guest_current_source_changed_replan_required');
    }
    const resources = observed.source.resources.filter((value) => value.family === 'pii');
    const resource = resources[cursor.resourceIndex];
    if (!resource) blocked();
    const expected =
      cursor.witness.epochs.find(
        (value) => value.family === 'pii' && value.resourceId === resource.id
      ) ?? blocked();
    const result = await listGuestPiiDeletionMarkers(resource.database, {
      tenantId: context.lease.tenantId,
      ...(cursor.afterUserId !== null ? { afterUserId: cursor.afterUserId } : {}),
      limit: 16,
      expectedEpochRevision: expected.revision,
      authorize: () => input.authorize(context),
    });
    for (const value of result.markers) {
      cursor.witness.denyDigest = await hash(
        JSON.stringify([cursor.witness.denyDigest, resource.id, value])
      );
      cursor.witness.markerCount++;
    }
    await input.apply(context, planDigest, structuredClone(result.markers));
    if (result.nextCursor !== null) cursor.afterUserId = result.nextCursor;
    else {
      cursor.resourceIndex++;
      cursor.afterUserId = null;
    }
    await assertCurrent(context, cursor.witness);
    if (cursor.resourceIndex < resources.length)
      return { cursor: JSON.stringify(cursor), done: false };
    await input.save(context, cursor.witness);
    return { cursor: null, done: true };
  }
  async function ready(context: TenantBackupStepContext, planDigest: string) {
    return input.load(context, planDigest, (witness) => assertCurrent(context, witness));
  }
  return { wrap, page, ready, assertCurrent };
}
