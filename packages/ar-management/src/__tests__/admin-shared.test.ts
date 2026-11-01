import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { decryptLogIcebergRecord } from '@authrim/ar-lib-core/services/log-iceberg-record';
import { decryptProtectedLogIcebergDetail } from '@authrim/ar-lib-core/services/log-iceberg-row-codec';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { adminSessionAuditDigest } from '@authrim/ar-lib-core';
import { writeAdminAuditLog } from '../admin-shared';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));

const TENANT = 'tenant-1';
for (const mode of ['scheduled', 'pipeline'] as const) {
  describe(`admin-shared canonical audit (${mode})`, () => {
    let f: Awaited<ReturnType<typeof logProducerFixture>>;
    const oldPut = vi.fn(() => {
      throw new Error('old archive must not receive a log');
    });
    beforeEach(async () => {
      f = await logProducerFixture(mode, { tenantId: TENANT, separateAdmin: true });
      oldPut.mockClear();
    });
    afterEach(() => {
      vi.restoreAllMocks();
      f.close();
    });
    function context(
      options: {
        env?: Partial<Env>;
        headers?: Record<string, string>;
        requestId?: string;
        actor?: Record<string, unknown>;
      } = {}
    ) {
      const store = new Map<string, unknown>([
        ['tenantId', TENANT],
        ['requestId', options.requestId],
        [
          'adminAuth',
          options.actor ?? {
            userId: 'admin-1',
            authMethod: 'session',
            email: 'admin@example.com',
            sessionId: 'sess-1',
          },
        ],
      ]);
      const headers = new Map(
        Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
      );
      return {
        env: {
          ...f.env,
          SENSITIVE_DETAILS: { put: oldPut },
          AUDIT_ARCHIVE: { put: oldPut },
          ...options.env,
        },
        req: {
          header: (name: string) =>
            headers.get(name.toLowerCase()) ??
            (name === 'CF-Connecting-IP'
              ? '203.0.113.9'
              : name === 'User-Agent'
                ? 'VitestAgent/1.0'
                : undefined),
        },
        get: (key: string) => store.get(key),
      } as unknown as Parameters<typeof writeAdminAuditLog>[0];
    }
    const input = {
      action: 'admin.role.updated',
      resourceType: 'admin_role',
      resourceId: 'role-1',
      result: 'success' as const,
      metadata: { ticket: 'CASE-123', diff: ['name'] },
      before: { display_name: 'Old Name' },
      after: { display_name: 'New Name' },
    };
    async function records(): Promise<LogArchiveRecord[]> {
      return mode === 'scheduled'
        ? f.staging.readTenant({
            tenantId: TENANT,
            tenantKey: 'key-' + TENANT,
            sourceDataset: 'admin.admin_audit_log',
            now: Date.now(),
          })
        : [...f.objects.values()].map((v) => JSON.parse(v.text) as LogArchiveRecord);
    }
    async function detail(record: LogArchiveRecord) {
      const body = await decryptLogIcebergRecord(
        record,
        {
          tenantKey: record.tenant_key,
          sourceDataset: record.source_dataset,
          eventId: record.event_id,
        },
        async () => f.keys
      );
      return decryptProtectedLogIcebergDetail({ record, body, resolveKeys: async () => f.keys });
    }
    it('stores a protected detail durably without an old DB/object/chunk copy', async () => {
      const id = await writeAdminAuditLog(context(), input);
      expect(id).toEqual(expect.any(String));
      const [record] = await records();
      expect(record.event_id).toBe(id);
      expect(await f.rows('admin.admin_audit_log', TENANT)).toMatchObject([
        {
          before_json: null,
          after_json: null,
          metadata_json: JSON.stringify({
            admin_actor_type: 'admin_user',
            admin_actor_id: 'admin-1',
            admin_auth_method: 'session',
          }),
        },
      ]);
      expect(await detail(record)).toMatchObject({
        before_json: JSON.stringify(input.before),
        after_json: JSON.stringify(input.after),
      });
      const full = await detail(record);
      expect(JSON.parse(String(full?.metadata_json))).toMatchObject(input.metadata);
      const stored =
        JSON.stringify(f.adminDb.prepare('SELECT * FROM log_iceberg_record_parts').all()) +
        JSON.stringify([...f.objects.values()]);
      expect(stored).not.toContain('Old Name');
      expect(stored).not.toContain('CASE-123');
      expect(
        f.adminDb
          .prepare(
            `SELECT count(*) n FROM ${mode === 'scheduled' ? 'log_iceberg_records' : 'log_iceberg_outbox'}`
          )
          .get()?.n
      ).toBe(1);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_log').get()?.n).toBe(0);
      expect(oldPut).not.toHaveBeenCalled();
      if (mode === 'scheduled') {
        expect(f.objects.size).toBe(0);
        expect(f.queueMessages).toEqual([]);
      } else {
        expect(f.adminDb.prepare('SELECT count(*) n FROM log_iceberg_record_parts').get()?.n).toBe(
          0
        );
        expect(f.queueMessages).toHaveLength(1);
      }
    });
    it('records only a digest of the Admin session ID', async () => {
      await writeAdminAuditLog(context(), input);
      const [row] = await f.rows('admin.admin_audit_log', TENANT);
      expect(row.session_id).toBe(await adminSessionAuditDigest('sess-1'));
      expect(String(row.session_id)).toMatch(/^sha256:[a-f0-9]{32}$/u);
      expect(JSON.stringify(row)).not.toContain('sess-1');
    });
    it('resolves the opaque tenant key through Core instead of the Admin store', async () => {
      f.db.prepare('UPDATE tenants SET tenant_key=? WHERE id=?').run('t_core_tenant', TENANT);
      const adminQuery = vi.spyOn(f.adminAdapter, 'queryOne');
      const id = await writeAdminAuditLog(context(), input);
      expect(id).toEqual(expect.any(String));
      const record =
        mode === 'pipeline'
          ? (JSON.parse([...f.objects.values()][0].text) as LogArchiveRecord)
          : (
              await f.staging.readTenant({
                tenantId: TENANT,
                tenantKey: 't_core_tenant',
                sourceDataset: 'admin.admin_audit_log',
                now: Date.now(),
              })
            )[0];
      expect(record.tenant_key).toBe('t_core_tenant');
      expect(adminQuery.mock.calls.every(([sql]) => !sql.includes('FROM tenants'))).toBe(true);
    });
    it('fails closed without encryption material and creates no plaintext fallback', async () => {
      expect(
        await writeAdminAuditLog(context({ env: { OBJECT_ENCRYPTION_ROOT_KEY: undefined } }), input)
      ).toBeNull();
      expect(await records()).toEqual([]);
      expect(f.adminDb.prepare('SELECT count(*) n FROM admin_audit_receipts').get()?.n).toBe(0);
      expect(oldPut).not.toHaveBeenCalled();
    });
    it('does not depend on the former sensitive-detail storage', async () => {
      expect(
        await writeAdminAuditLog(
          context({ env: { SENSITIVE_DETAILS: undefined, AUDIT_ARCHIVE: undefined } }),
          input
        )
      ).toEqual(expect.any(String));
      expect(await records()).toHaveLength(1);
      expect(oldPut).not.toHaveBeenCalled();
    });
    it('keeps trusted request/BFF metadata inline while arbitrary metadata stays protected', async () => {
      const c = context({
        requestId: 'mgmt-req-1',
        headers: {
          'X-Request-Id': 'bff-req-1',
          'X-Correlation-Id': 'corr-1',
          'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
          'X-Authrim-Forwarded-Host': 'api.authrim.example',
          'X-Forwarded-Proto': 'https',
        },
      });
      await writeAdminAuditLog(c, {
        ...input,
        metadata: { admin_ui_api_mode: 'spoofed', ticket: 'CASE-456' },
      });
      const [row] = await f.rows('admin.admin_audit_log', TENANT);
      expect(row.request_id).toBe('mgmt-req-1');
      expect(JSON.parse(String(row.metadata_json))).toEqual({
        admin_ui_api_mode: 'cross-site-proxy-bff',
        admin_ui_bff_forwarded_host: 'api.authrim.example',
        admin_ui_bff_forwarded_proto: 'https',
        admin_ui_bff_request_id: 'bff-req-1',
        admin_ui_bff_correlation_id: 'corr-1',
        admin_actor_type: 'admin_user',
        admin_actor_id: 'admin-1',
        admin_auth_method: 'session',
      });
      expect(JSON.parse(String((await detail((await records())[0]))?.metadata_json))).toMatchObject(
        { ticket: 'CASE-456', admin_ui_api_mode: 'cross-site-proxy-bff' }
      );
    });
    it('records machine actor/credential metadata without a human identity', async () => {
      await writeAdminAuditLog(
        context({
          actor: {
            userId: 'amp_mcp_admin',
            authMethod: 'machine_access_token',
            actorType: 'machine',
            actorId: 'amp_mcp_admin',
            principalType: 'mcp_server',
            credentialId: 'amk_mcp_admin',
            clientId: 'mcp-admin-server',
            clientAuthMethod: 'private_key_jwt',
            credentialStrength: 'asymmetric_key',
            senderConstrained: false,
          },
        }),
        { ...input, action: 'ai_grant.created' }
      );
      const [row] = await f.rows('admin.admin_audit_log', TENANT);
      expect(row.admin_user_id).toBeNull();
      expect(row.admin_email).toBeNull();
      expect(JSON.parse(String(row.metadata_json))).toMatchObject({
        admin_actor_type: 'machine',
        admin_actor_id: 'amp_mcp_admin',
        admin_auth_method: 'machine_access_token',
        admin_machine_principal_id: 'amp_mcp_admin',
        admin_machine_principal_type: 'mcp_server',
        admin_machine_credential_id: 'amk_mcp_admin',
        admin_machine_client_id: 'mcp-admin-server',
        admin_machine_client_auth_method: 'private_key_jwt',
        admin_machine_credential_strength: 'asymmetric_key',
        admin_machine_sender_constrained: false,
      });
    });
    it('records an Agent separately from the delegating administrator', async () => {
      await writeAdminAuditLog(
        context({
          actor: {
            userId: 'admin-1',
            authMethod: 'bearer',
            actorType: 'agent',
            actorId: 'client:client-1',
            clientId: 'client-1',
            agentMode: 'mode_a',
            agentAssurance: 'public_client_transaction',
            agentGrantId: 'grant-1',
            agentGrantGeneration: 2,
            agentConsentVersion: 3,
            sourceTokenJti: 'source-jti',
            correlationId: 'correlation-1',
          },
        }),
        { ...input, action: 'agent.tool.executed' }
      );
      const [row] = await f.rows('admin.admin_audit_log', TENANT);
      expect(row.admin_user_id).toBe('admin-1');
      expect(JSON.parse(String(row.metadata_json))).toMatchObject({
        admin_actor_type: 'agent',
        admin_actor_id: 'client:client-1',
        admin_delegator_id: 'admin-1',
        admin_agent_client_id: 'client-1',
        admin_agent_mode: 'mode_a',
        admin_agent_assurance: 'public_client_transaction',
        admin_agent_grant_id: 'grant-1',
        admin_agent_grant_generation: 2,
        admin_agent_consent_version: 3,
        admin_agent_source_token_jti: 'source-jti',
        admin_agent_correlation_id: 'correlation-1',
      });
    });
  });
}
