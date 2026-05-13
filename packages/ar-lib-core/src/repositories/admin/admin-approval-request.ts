/**
 * Approval / Elevation Repository
 *
 * Stores approval requests, per-approver decisions, and short-lived elevation
 * grant metadata in DB_ADMIN.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { requireTenantId } from '../tenant';
import {
  BaseRepository,
  type BaseEntity,
  generateId,
  getCurrentTimestamp,
} from '../base';
import type {
  ApprovalDecisionStatus,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalRequestApprovalCreateInput,
  ApprovalRequestApprovalUpdateInput,
  ApprovalRequestCreateInput,
  ApprovalRequestStatus,
  ElevationGrant,
  ElevationGrantCreateInput,
  ElevationGrantStatus,
  StructuredReference,
} from '../../types/approval';
import {
  generatePublicApprovalRequestId,
  generatePublicElevationGrantId,
} from '../../services/approval-governance';

interface ApprovalRequestEntity extends BaseEntity {
  public_request_id: string;
  tenant_id: string;
  investigation_id: string;
  requester_subject_type: string;
  requester_subject_id: string;
  target_subject_type: string;
  target_subject_id: string;
  request_surface: string;
  requested_action: string;
  redaction_level: string;
  status: string;
  scope_canonical: string;
  scope_json: string;
  reason_code: string;
  reason_note: string | null;
  reference_system: string | null;
  reference_value: string | null;
  reference_url: string | null;
  ticket_reference_system: string | null;
  ticket_reference_value: string | null;
  ticket_reference_url: string | null;
  reuse_scope: string;
  policy_preset: string;
  partial_access_allowed: number;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  detail_object_catalog_id: string | null;
}

interface ApprovalRequestApprovalEntity extends BaseEntity {
  approval_request_id: string;
  step_key: string;
  side: string;
  subject_type: string;
  subject_id: string | null;
  relation_type: string | null;
  relation_source: string | null;
  status: string;
  method: string | null;
  transport_channel: string | null;
  reason_code: string | null;
  reason_note: string | null;
  last_notification_action: string | null;
  last_notified_at: number | null;
  notification_count: number;
  requested_at: number;
  decided_at: number | null;
  expires_at: number;
}

interface ElevationGrantEntity extends BaseEntity {
  public_grant_id: string;
  approval_request_id: string;
  tenant_id: string;
  status: string;
  target_audience: string;
  resource_class: string;
  redaction_level: string;
  scope_canonical: string;
  scope_json: string;
  authorization_details_json: string | null;
  requester_subject_type: string;
  requester_subject_id: string;
  actor_subject_type: string;
  actor_subject_id: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

function parseReference(
  system: string | null,
  value: string | null,
  url: string | null
): StructuredReference | null {
  if (!system || !value) {
    return null;
  }

  return {
    system,
    id: value,
    ...(url ? { url } : {}),
  };
}

export class ApprovalRequestRepository extends BaseRepository<ApprovalRequestEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'approval_requests',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'public_request_id',
        'tenant_id',
        'investigation_id',
        'requester_subject_type',
        'requester_subject_id',
        'target_subject_type',
        'target_subject_id',
        'request_surface',
        'requested_action',
        'redaction_level',
        'status',
        'scope_canonical',
        'reason_code',
        'requested_at',
        'expires_at',
        'decided_at',
      ],
    });
  }

  async createApprovalRequest(input: ApprovalRequestCreateInput): Promise<ApprovalRequest> {
    const id = generateId();
    const now = getCurrentTimestamp();
    const requestedAt = input.requested_at ?? now;

    const entity: ApprovalRequestEntity = {
      id,
      public_request_id: input.public_request_id ?? generatePublicApprovalRequestId(),
      tenant_id: requireTenantId(input.tenant_id, 'Repository create'),
      investigation_id: input.investigation_id,
      requester_subject_type: input.requester_subject_type,
      requester_subject_id: input.requester_subject_id,
      target_subject_type: input.target_subject_type,
      target_subject_id: input.target_subject_id,
      request_surface: input.request_surface,
      requested_action: input.requested_action,
      redaction_level: input.redaction_level ?? 'masked',
      status: input.status ?? 'pending',
      scope_canonical: input.scope_canonical,
      scope_json: JSON.stringify(input.scope_json),
      reason_code: input.reason_code,
      reason_note: input.reason_note ?? null,
      reference_system: input.reference?.system ?? null,
      reference_value: input.reference?.id ?? null,
      reference_url: input.reference?.url ?? null,
      ticket_reference_system: input.ticket_reference?.system ?? null,
      ticket_reference_value: input.ticket_reference?.id ?? null,
      ticket_reference_url: input.ticket_reference?.url ?? null,
      reuse_scope: input.reuse_scope ?? 'request',
      policy_preset: input.policy_preset,
      partial_access_allowed: input.partial_access_allowed ? 1 : 0,
      requested_at: requestedAt,
      expires_at: input.expires_at,
      decided_at: input.decided_at ?? null,
      detail_object_catalog_id: input.detail_object_catalog_id ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO approval_requests (
        id, public_request_id, tenant_id, investigation_id,
        requester_subject_type, requester_subject_id,
        target_subject_type, target_subject_id,
        request_surface, requested_action, redaction_level, status,
        scope_canonical, scope_json,
        reason_code, reason_note,
        reference_system, reference_value, reference_url,
        ticket_reference_system, ticket_reference_value, ticket_reference_url,
        reuse_scope, policy_preset, partial_access_allowed,
        requested_at, expires_at, decided_at, detail_object_catalog_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.id,
        entity.public_request_id,
        entity.tenant_id,
        entity.investigation_id,
        entity.requester_subject_type,
        entity.requester_subject_id,
        entity.target_subject_type,
        entity.target_subject_id,
        entity.request_surface,
        entity.requested_action,
        entity.redaction_level,
        entity.status,
        entity.scope_canonical,
        entity.scope_json,
        entity.reason_code,
        entity.reason_note,
        entity.reference_system,
        entity.reference_value,
        entity.reference_url,
        entity.ticket_reference_system,
        entity.ticket_reference_value,
        entity.ticket_reference_url,
        entity.reuse_scope,
        entity.policy_preset,
        entity.partial_access_allowed,
        entity.requested_at,
        entity.expires_at,
        entity.decided_at,
        entity.detail_object_catalog_id,
        entity.created_at,
        entity.updated_at,
      ]
    );

    return this.entityToApprovalRequest(entity);
  }

  async getApprovalRequestById(id: string): Promise<ApprovalRequest | null> {
    const row = await this.findById(id);
    return row ? this.entityToApprovalRequest(row) : null;
  }

  async getApprovalRequestByPublicId(publicRequestId: string): Promise<ApprovalRequest | null> {
    const row = await this.adapter.queryOne<ApprovalRequestEntity>(
      'SELECT * FROM approval_requests WHERE public_request_id = ?',
      [publicRequestId]
    );
    return row ? this.entityToApprovalRequest(row) : null;
  }

  async updateApprovalRequestStatus(
    id: string,
    status: ApprovalRequestStatus,
    options?: { decidedAt?: number | null }
  ): Promise<ApprovalRequest | null> {
    const now = getCurrentTimestamp();
    const decidedAt =
      options?.decidedAt ?? (status === 'approved' || status === 'denied' ? now : null);

    await this.adapter.execute(
      `UPDATE approval_requests
       SET status = ?, decided_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, decidedAt, now, id]
    );

    return this.getApprovalRequestById(id);
  }

  async updateApprovalRequestDetailObjectCatalogId(
    id: string,
    detailObjectCatalogId: string | null
  ): Promise<ApprovalRequest | null> {
    const now = getCurrentTimestamp();
    await this.adapter.execute(
      `UPDATE approval_requests
       SET detail_object_catalog_id = ?, updated_at = ?
       WHERE id = ?`,
      [detailObjectCatalogId, now, id]
    );

    return this.getApprovalRequestById(id);
  }

  async listApprovalRequestsByInvestigation(investigationId: string): Promise<ApprovalRequest[]> {
    const rows = await this.adapter.query<ApprovalRequestEntity>(
      `SELECT * FROM approval_requests
       WHERE investigation_id = ?
       ORDER BY created_at DESC`,
      [investigationId]
    );
    return rows.map((row) => this.entityToApprovalRequest(row));
  }

  async listApprovalRequests(filters?: {
    tenantId?: string;
    status?: ApprovalRequestStatus;
    investigationId?: string;
    limit?: number;
  }): Promise<ApprovalRequest[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filters?.tenantId) {
      where.push('tenant_id = ?');
      params.push(filters.tenantId);
    }
    if (filters?.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.investigationId) {
      where.push('investigation_id = ?');
      params.push(filters.investigationId);
    }

    const sql = `
      SELECT * FROM approval_requests
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(filters?.limit ?? 50, 200))}
    `;

    const rows = await this.adapter.query<ApprovalRequestEntity>(sql, params);
    return rows.map((row) => this.entityToApprovalRequest(row));
  }

  private entityToApprovalRequest(entity: ApprovalRequestEntity): ApprovalRequest {
    return {
      id: entity.id,
      public_request_id: entity.public_request_id,
      tenant_id: entity.tenant_id,
      investigation_id: entity.investigation_id,
      requester_subject_type: entity.requester_subject_type as ApprovalRequest['requester_subject_type'],
      requester_subject_id: entity.requester_subject_id,
      target_subject_type: entity.target_subject_type as ApprovalRequest['target_subject_type'],
      target_subject_id: entity.target_subject_id,
      request_surface: entity.request_surface,
      requested_action: entity.requested_action,
      redaction_level: entity.redaction_level as ApprovalRequest['redaction_level'],
      status: entity.status as ApprovalRequest['status'],
      scope_canonical: entity.scope_canonical,
      scope_json: JSON.parse(entity.scope_json) as ApprovalRequest['scope_json'],
      reason_code: entity.reason_code,
      reason_note: entity.reason_note,
      reference: parseReference(entity.reference_system, entity.reference_value, entity.reference_url),
      ticket_reference: parseReference(
        entity.ticket_reference_system,
        entity.ticket_reference_value,
        entity.ticket_reference_url
      ),
      reuse_scope: entity.reuse_scope as ApprovalRequest['reuse_scope'],
      policy_preset: entity.policy_preset,
      partial_access_allowed: entity.partial_access_allowed === 1,
      requested_at: entity.requested_at,
      expires_at: entity.expires_at,
      decided_at: entity.decided_at,
      detail_object_catalog_id: entity.detail_object_catalog_id,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}

export class ApprovalRequestApprovalRepository extends BaseRepository<ApprovalRequestApprovalEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'approval_request_approvals',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'approval_request_id',
        'step_key',
        'side',
        'subject_type',
        'subject_id',
        'relation_type',
        'status',
        'requested_at',
        'expires_at',
        'decided_at',
      ],
    });
  }

  async createApproval(input: ApprovalRequestApprovalCreateInput): Promise<ApprovalRequestApproval> {
    const id = generateId();
    const now = getCurrentTimestamp();
    const requestedAt = input.requested_at ?? now;
    const entity: ApprovalRequestApprovalEntity = {
      id,
      approval_request_id: input.approval_request_id,
      step_key: input.step_key,
      side: input.side,
      subject_type: input.subject_type,
      subject_id: input.subject_id ?? null,
      relation_type: input.relation_type ?? null,
      relation_source: input.relation_source ?? null,
      status: input.status ?? 'pending',
      method: input.method ?? null,
      transport_channel: input.transport_channel ?? null,
      reason_code: input.reason_code ?? null,
      reason_note: input.reason_note ?? null,
      last_notification_action: input.last_notification_action ?? null,
      last_notified_at: input.last_notified_at ?? null,
      notification_count: input.notification_count ?? 0,
      requested_at: requestedAt,
      decided_at: input.decided_at ?? null,
      expires_at: input.expires_at,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO approval_request_approvals (
        id, approval_request_id, step_key, side, subject_type, subject_id,
        relation_type, relation_source, status, method, transport_channel,
        reason_code, reason_note, last_notification_action, last_notified_at,
        notification_count, requested_at, decided_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.id,
        entity.approval_request_id,
        entity.step_key,
        entity.side,
        entity.subject_type,
        entity.subject_id,
        entity.relation_type,
        entity.relation_source,
        entity.status,
        entity.method,
        entity.transport_channel,
        entity.reason_code,
        entity.reason_note,
        entity.last_notification_action,
        entity.last_notified_at,
        entity.notification_count,
        entity.requested_at,
        entity.decided_at,
        entity.expires_at,
        entity.created_at,
        entity.updated_at,
      ]
    );

    return this.entityToApproval(entity);
  }

  async listApprovalsForRequest(approvalRequestId: string): Promise<ApprovalRequestApproval[]> {
    const rows = await this.adapter.query<ApprovalRequestApprovalEntity>(
      `SELECT * FROM approval_request_approvals
       WHERE approval_request_id = ?
       ORDER BY created_at ASC`,
      [approvalRequestId]
    );
    return rows.map((row) => this.entityToApproval(row));
  }

  async getApprovalById(id: string): Promise<ApprovalRequestApproval | null> {
    const row = await this.findById(id);
    return row ? this.entityToApproval(row) : null;
  }

  async updateApproval(
    id: string,
    input: ApprovalRequestApprovalUpdateInput
  ): Promise<ApprovalRequestApproval | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (input.status !== undefined) {
      updates.push('status = ?');
      values.push(input.status);
    }
    if (input.subject_id !== undefined) {
      updates.push('subject_id = ?');
      values.push(input.subject_id);
    }
    if (input.method !== undefined) {
      updates.push('method = ?');
      values.push(input.method);
    }
    if (input.transport_channel !== undefined) {
      updates.push('transport_channel = ?');
      values.push(input.transport_channel);
    }
    if (input.reason_code !== undefined) {
      updates.push('reason_code = ?');
      values.push(input.reason_code);
    }
    if (input.reason_note !== undefined) {
      updates.push('reason_note = ?');
      values.push(input.reason_note);
    }
    if (input.last_notification_action !== undefined) {
      updates.push('last_notification_action = ?');
      values.push(input.last_notification_action);
    }
    if (input.last_notified_at !== undefined) {
      updates.push('last_notified_at = ?');
      values.push(input.last_notified_at);
    }
    if (input.notification_count !== undefined) {
      updates.push('notification_count = ?');
      values.push(input.notification_count);
    }
    if (input.decided_at !== undefined) {
      updates.push('decided_at = ?');
      values.push(input.decided_at);
    }
    if (input.expires_at !== undefined) {
      updates.push('expires_at = ?');
      values.push(input.expires_at);
    }

    if (updates.length === 0) {
      return this.entityToApproval(existing);
    }

    updates.push('updated_at = ?');
    values.push(getCurrentTimestamp());
    values.push(id);

    await this.adapter.execute(
      `UPDATE approval_request_approvals SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    const updated = await this.findById(id);
    return updated ? this.entityToApproval(updated) : null;
  }

  private entityToApproval(entity: ApprovalRequestApprovalEntity): ApprovalRequestApproval {
    return {
      id: entity.id,
      approval_request_id: entity.approval_request_id,
      step_key: entity.step_key,
      side: entity.side as ApprovalRequestApproval['side'],
      subject_type: entity.subject_type as ApprovalRequestApproval['subject_type'],
      subject_id: entity.subject_id,
      relation_type: entity.relation_type,
      relation_source: entity.relation_source,
      status: entity.status as ApprovalDecisionStatus,
      method: entity.method as ApprovalRequestApproval['method'],
      transport_channel: entity.transport_channel,
      reason_code: entity.reason_code,
      reason_note: entity.reason_note,
      last_notification_action:
        entity.last_notification_action as ApprovalRequestApproval['last_notification_action'],
      last_notified_at: entity.last_notified_at,
      notification_count: entity.notification_count,
      requested_at: entity.requested_at,
      decided_at: entity.decided_at,
      expires_at: entity.expires_at,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}

export class ElevationGrantRepository extends BaseRepository<ElevationGrantEntity> {
  constructor(adapter: DatabaseAdapter) {
    super(adapter, {
      tableName: 'elevation_grants',
      primaryKey: 'id',
      softDelete: false,
      allowedFields: [
        'public_grant_id',
        'approval_request_id',
        'tenant_id',
        'status',
        'target_audience',
        'resource_class',
        'redaction_level',
        'issued_at',
        'expires_at',
        'revoked_at',
      ],
    });
  }

  async createElevationGrant(input: ElevationGrantCreateInput): Promise<ElevationGrant> {
    const id = generateId();
    const now = getCurrentTimestamp();
    const issuedAt = input.issued_at ?? now;
    const entity: ElevationGrantEntity = {
      id,
      public_grant_id: input.public_grant_id ?? generatePublicElevationGrantId(),
      approval_request_id: input.approval_request_id,
      tenant_id: input.tenant_id,
      status: input.status ?? 'active',
      target_audience: input.target_audience,
      resource_class: input.resource_class,
      redaction_level: input.redaction_level,
      scope_canonical: input.scope_canonical,
      scope_json: JSON.stringify(input.scope_json),
      authorization_details_json: input.authorization_details_json
        ? JSON.stringify(input.authorization_details_json)
        : null,
      requester_subject_type: input.requester_subject_type,
      requester_subject_id: input.requester_subject_id,
      actor_subject_type: input.actor_subject_type,
      actor_subject_id: input.actor_subject_id,
      issued_at: issuedAt,
      expires_at: input.expires_at,
      revoked_at: input.revoked_at ?? null,
      revoke_reason: input.revoke_reason ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.adapter.execute(
      `INSERT INTO elevation_grants (
        id, public_grant_id, approval_request_id, tenant_id, status,
        target_audience, resource_class, redaction_level,
        scope_canonical, scope_json, authorization_details_json,
        requester_subject_type, requester_subject_id,
        actor_subject_type, actor_subject_id,
        issued_at, expires_at, revoked_at, revoke_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.id,
        entity.public_grant_id,
        entity.approval_request_id,
        entity.tenant_id,
        entity.status,
        entity.target_audience,
        entity.resource_class,
        entity.redaction_level,
        entity.scope_canonical,
        entity.scope_json,
        entity.authorization_details_json,
        entity.requester_subject_type,
        entity.requester_subject_id,
        entity.actor_subject_type,
        entity.actor_subject_id,
        entity.issued_at,
        entity.expires_at,
        entity.revoked_at,
        entity.revoke_reason,
        entity.created_at,
        entity.updated_at,
      ]
    );

    return this.entityToGrant(entity);
  }

  async getElevationGrantByPublicId(publicGrantId: string): Promise<ElevationGrant | null> {
    const row = await this.adapter.queryOne<ElevationGrantEntity>(
      'SELECT * FROM elevation_grants WHERE public_grant_id = ?',
      [publicGrantId]
    );
    return row ? this.entityToGrant(row) : null;
  }

  async listElevationGrantsForRequest(approvalRequestId: string): Promise<ElevationGrant[]> {
    const rows = await this.adapter.query<ElevationGrantEntity>(
      `SELECT * FROM elevation_grants
       WHERE approval_request_id = ?
       ORDER BY created_at ASC`,
      [approvalRequestId]
    );
    return rows.map((row) => this.entityToGrant(row));
  }

  async listActiveElevationGrants(filters: {
    tenantId: string;
    actorSubjectType: string;
    actorSubjectId: string;
    resourceClass?: string;
    targetAudience?: string;
    now?: number;
  }): Promise<ElevationGrant[]> {
    const now = filters.now ?? getCurrentTimestamp();
    const where = [
      'tenant_id = ?',
      'status = ?',
      'actor_subject_type = ?',
      'actor_subject_id = ?',
    ];
    const params: unknown[] = [
      filters.tenantId,
      'active',
      filters.actorSubjectType,
      filters.actorSubjectId,
    ];

    if (filters.resourceClass) {
      where.push('resource_class = ?');
      params.push(filters.resourceClass);
    }

    if (filters.targetAudience) {
      where.push('target_audience = ?');
      params.push(filters.targetAudience);
    }

    where.push('expires_at > ?');
    params.push(now);

    const rows = await this.adapter.query<ElevationGrantEntity>(
      `SELECT * FROM elevation_grants
       WHERE ${where.join(' AND ')}
       ORDER BY issued_at DESC, created_at DESC`,
      params
    );
    return rows
      .filter((row) => row.revoked_at === null || row.revoked_at === 0)
      .map((row) => this.entityToGrant(row));
  }

  async updateElevationGrantStatus(
    id: string,
    status: ElevationGrantStatus,
    options?: { revokedAt?: number | null; revokeReason?: string | null }
  ): Promise<ElevationGrant | null> {
    const now = getCurrentTimestamp();
    await this.adapter.execute(
      `UPDATE elevation_grants
       SET status = ?, revoked_at = ?, revoke_reason = ?, updated_at = ?
       WHERE id = ?`,
      [status, options?.revokedAt ?? null, options?.revokeReason ?? null, now, id]
    );
    const updated = await this.findById(id);
    return updated ? this.entityToGrant(updated) : null;
  }

  private entityToGrant(entity: ElevationGrantEntity): ElevationGrant {
    return {
      id: entity.id,
      public_grant_id: entity.public_grant_id,
      approval_request_id: entity.approval_request_id,
      tenant_id: entity.tenant_id,
      status: entity.status as ElevationGrantStatus,
      target_audience: entity.target_audience,
      resource_class: entity.resource_class,
      redaction_level: entity.redaction_level as ElevationGrant['redaction_level'],
      scope_canonical: entity.scope_canonical,
      scope_json: JSON.parse(entity.scope_json) as ElevationGrant['scope_json'],
      authorization_details_json: entity.authorization_details_json
        ? (JSON.parse(entity.authorization_details_json) as Record<string, unknown>)
        : null,
      requester_subject_type:
        entity.requester_subject_type as ElevationGrant['requester_subject_type'],
      requester_subject_id: entity.requester_subject_id,
      actor_subject_type: entity.actor_subject_type as ElevationGrant['actor_subject_type'],
      actor_subject_id: entity.actor_subject_id,
      issued_at: entity.issued_at,
      expires_at: entity.expires_at,
      revoked_at: entity.revoked_at,
      revoke_reason: entity.revoke_reason,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}
