import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  return {
    db,
    generateId: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.db })),
    createAuditLogFromContext: mocks.audit,
    generateId: mocks.generateId,
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
      })),
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant-1'),
  };
});

import {
  adminFlowAssignmentDeleteHandler,
  adminFlowAssignmentUpsertHandler,
  adminFlowCreateHandler,
  adminFlowDeleteHandler,
  adminFlowExportHandler,
  adminFlowImportHandler,
  adminFlowPublishHandler,
  adminFlowUpdateHandler,
  adminFlowValidateHandler,
} from '../admin-flows';

interface TestFlowRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  profile_id: string | null;
  name: string;
  description: string | null;
  graph_definition: string | null;
  compiled_plan: string | null;
  version: string;
  is_active: number;
  is_builtin: number;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
  slug: string | null;
  display_name: string | null;
  kind: string;
  status: string;
  draft_editor_json: string | null;
  draft_runtime_base_json: string | null;
  published_version_id: string | null;
  deleted_at: number | null;
  template_id: string | null;
}

const validEditor = {
  nodes: [
    { id: 'entry', type: 'entry' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [{ id: 'edge-1', source: 'entry', source_handle: 'next', target: 'complete' }],
};

let flows: TestFlowRow[];
let versions: Array<Record<string, unknown>>;
let assignments: Array<Record<string, unknown>>;

function createContext(options: {
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
}) {
  const json = vi.fn((body: unknown, status?: number) => {
    return new Response(JSON.stringify(body), {
      status: status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return {
    req: {
      json: vi.fn(async () => options.body ?? {}),
      param: vi.fn((name: string) => options.params?.[name]),
      query: vi.fn(() => options.query ?? {}),
    },
    get: vi.fn((name: string) => (name === 'adminAuth' ? { userId: 'admin-1' } : undefined)),
    json,
  } as never;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (!isRecord(parsed)) {
    throw new Error('Expected JSON response object');
  }
  return parsed;
}

function parseRuntimeJson(value: string | null | undefined): {
  flow_id?: string;
  flow_kind?: string;
  ui: { steps: Array<{ source_node_id: string }> };
} {
  if (!value) {
    throw new Error('Expected runtime JSON');
  }
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !isRecord(parsed.ui) || !Array.isArray(parsed.ui.steps)) {
    throw new Error('Expected runtime JSON with ui.steps');
  }
  return parsed as {
    flow_id?: string;
    flow_kind?: string;
    ui: { steps: Array<{ source_node_id: string }> };
  };
}

function installDbMock() {
  mocks.db.queryOne.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('MAX(version_number)')) {
      const flowId = params[1];
      const versionNumbers = versions
        .filter((version) => version.flow_id === flowId)
        .map((version) => Number(version.version_number));
      return { version_number: versionNumbers.length > 0 ? Math.max(...versionNumbers) : null };
    }

    if (
      sql.includes('FROM flows') &&
      sql.includes('id = ?') &&
      sql.includes('deleted_at IS NULL')
    ) {
      const flowId = params.at(-1);
      return flows.find((flow) => flow.id === flowId && flow.deleted_at === null) ?? null;
    }

    if (sql.includes('FROM flows') && sql.includes('slug = ?')) {
      const slug = params[1];
      const excludeFlowId = params.length > 2 ? params[2] : null;
      return (
        flows.find(
          (flow) => flow.slug === slug && flow.id !== excludeFlowId && flow.deleted_at === null
        ) ?? null
      );
    }

    if (sql.includes('FROM flow_assignments')) {
      if (sql.includes('target_id IS NULL')) {
        return (
          assignments.find(
            (assignment) =>
              assignment.tenant_id === params[0] &&
              assignment.target_type === params[1] &&
              assignment.target_id === null &&
              assignment.flow_kind === params[2]
          ) ?? null
        );
      }
      return (
        assignments.find(
          (assignment) =>
            assignment.tenant_id === params[0] &&
            assignment.target_type === params[1] &&
            assignment.target_id === params[2] &&
            assignment.flow_kind === params[3]
        ) ?? null
      );
    }

    return null;
  });

  mocks.db.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM flow_versions')) {
      return versions;
    }
    if (sql.includes('FROM flow_assignments')) {
      return assignments;
    }
    return flows;
  });

  mocks.db.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO flows')) {
      flows.push({
        id: String(params[0]),
        tenant_id: String(params[1]),
        client_id: params[2] as string | null,
        profile_id: params[3] as string | null,
        name: String(params[4]),
        description: params[5] as string | null,
        graph_definition: params[6] as string,
        compiled_plan: params[7] as string,
        version: String(params[8]),
        is_active: Number(params[9]),
        is_builtin: Number(params[10]),
        created_by: params[11] as string | null,
        created_at: Number(params[12]),
        updated_by: params[13] as string | null,
        updated_at: Number(params[14]),
        slug: String(params[15]),
        display_name: String(params[16]),
        kind: String(params[17]),
        status: String(params[18]),
        draft_editor_json: params[19] as string,
        draft_runtime_base_json: params[20] as string,
        published_version_id: null,
        deleted_at: null,
        template_id: params[21] as string | null,
      });
    }

    if (sql.includes('INSERT INTO flow_versions')) {
      versions.push({
        id: params[0],
        tenant_id: params[1],
        flow_id: params[2],
        version_number: params[3],
        schema_version: params[4],
        runtime_snapshot_json: params[5],
        editor_snapshot_json: params[6],
        validation_result_json: params[7],
        published_by: params[8],
        published_at: params[9],
        created_at: params[10],
      });
    }

    if (sql.includes('UPDATE flows') && sql.includes('published_version_id')) {
      const flow = flows.find((candidate) => candidate.id === params[5]);
      if (flow) {
        flow.status = String(params[0]);
        flow.is_active = 1;
        flow.published_version_id = String(params[1]);
      }
    }

    if (sql.startsWith('UPDATE flows SET')) {
      const flow = flows.find((candidate) => candidate.id === params.at(-1));
      const setClause = sql.match(/UPDATE flows SET (.*) WHERE tenant_id = \? AND id = \?/s)?.[1];
      if (flow && setClause) {
        const assignments = setClause.split(',').map((assignment) => assignment.trim());
        let paramIndex = 0;
        assignments.forEach((assignment) => {
          if (!assignment.includes('?')) {
            return;
          }
          const column = assignment.split('=')[0]?.trim();
          const value = params[paramIndex++];
          switch (column) {
            case 'display_name':
              flow.display_name = String(value);
              break;
            case 'name':
              flow.name = String(value);
              break;
            case 'kind':
              flow.kind = String(value);
              break;
            case 'status':
              flow.status = String(value);
              break;
            case 'draft_editor_json':
              flow.draft_editor_json = String(value);
              break;
            case 'graph_definition':
              flow.graph_definition = String(value);
              break;
            case 'draft_runtime_base_json':
              flow.draft_runtime_base_json = String(value);
              break;
            case 'compiled_plan':
              flow.compiled_plan = String(value);
              break;
            case 'published_version_id':
              flow.published_version_id = String(value);
              break;
            case 'template_id':
              flow.template_id = value as string | null;
              break;
            default:
              break;
          }
        });
      }
    }

    if (sql.includes('INSERT INTO flow_assignments')) {
      assignments.push({
        id: params[0],
        tenant_id: params[1],
        target_type: params[2],
        target_id: params[3],
        flow_kind: params[4],
        flow_id: params[5],
        enabled: params[6],
        created_at: params[7],
        updated_at: params[8],
      });
    }

    if (sql.includes('DELETE FROM flow_assignments')) {
      const tenantId = params[0];
      const targetType = params[1];
      const targetId = sql.includes('target_id IS NULL') ? null : params[2];
      const flowKind = sql.includes('target_id IS NULL') ? params[2] : params[3];
      assignments = assignments.filter(
        (assignment) =>
          !(
            assignment.tenant_id === tenantId &&
            assignment.target_type === targetType &&
            assignment.target_id === targetId &&
            assignment.flow_kind === flowKind
          )
      );
    }

    return { success: true, rowsAffected: 1 };
  });

  mocks.db.transaction.mockImplementation(async (fn: (tx: typeof mocks.db) => Promise<unknown>) => {
    return fn(mocks.db);
  });
}

function seedFlow(overrides: Partial<TestFlowRow> = {}) {
  flows.push({
    id: 'flow-1',
    tenant_id: 'tenant-1',
    client_id: null,
    profile_id: 'human-basic',
    name: 'Login Flow',
    description: null,
    graph_definition: JSON.stringify(validEditor),
    compiled_plan: null,
    version: '1.0.0',
    is_active: 1,
    is_builtin: 0,
    created_by: 'admin-1',
    created_at: 1,
    updated_by: 'admin-1',
    updated_at: 1,
    slug: 'login-flow',
    display_name: 'Login Flow',
    kind: 'login',
    status: 'draft',
    draft_editor_json: JSON.stringify(validEditor),
    draft_runtime_base_json: null,
    published_version_id: null,
    deleted_at: null,
    template_id: null,
    ...overrides,
  });
}

describe('admin Flow management handlers', () => {
  beforeEach(() => {
    flows = [];
    versions = [];
    assignments = [];
    vi.clearAllMocks();
    mocks.generateId.mockReset();
    mocks.generateId.mockReturnValue('generated-id');
    installDbMock();
  });

  it('does not allow draft create to set published status directly', async () => {
    const response = await adminFlowCreateHandler(
      createContext({
        body: {
          display_name: 'Login Flow',
          status: 'published',
        },
      })
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: 'invalid_request',
      error_description: 'Use the publish endpoint to publish a Flow',
    });
    expect(flows).toHaveLength(0);
  });

  it('stores template id separately from localized template descriptions', async () => {
    const response = await adminFlowCreateHandler(
      createContext({
        body: {
          slug: 'academic-saml-login',
          display_name: 'Academic SAML Login',
          description: null,
          template_id: 'academic-saml-login',
          kind: 'login',
          editor: validEditor,
        },
      })
    );
    const body = await readJson(response);

    expect(response.status).toBe(201);
    expect(flows[0]).toMatchObject({
      slug: 'academic-saml-login',
      description: null,
      template_id: 'academic-saml-login',
    });
    expect(body.flow).toMatchObject({
      description: null,
      template_id: 'academic-saml-login',
    });
  });

  it('publishes a valid draft as an immutable version snapshot', async () => {
    seedFlow();
    mocks.generateId.mockReturnValue('version-1');

    const response = await adminFlowPublishHandler(createContext({ params: { id: 'flow-1' } }));

    expect(response.status).toBe(200);
    expect(versions).toHaveLength(1);
    expect(flows[0].published_version_id).toBe('version-1');
    expect(JSON.parse(String(versions[0].runtime_snapshot_json))).toMatchObject({
      flow_id: 'flow-1',
      flow_kind: 'login',
    });
    expect(assignments).toHaveLength(0);
  });

  it('keeps single-protocol missing consent policy references publish-blocking', async () => {
    const editor = {
      nodes: [
        { id: 'entry', type: 'entry' },
        {
          id: 'oidc-consent',
          type: 'consent',
          config: {
            consent_policy_ref: 'missing-oidc-policy',
            completion_block: {
              id: 'oidc-authorization-completion',
              protocol: 'oidc',
              purpose: 'authorization',
              role: 'consent',
            },
          },
        },
        {
          id: 'oidc-complete',
          type: 'complete',
          config: {
            completion_block: {
              id: 'oidc-authorization-completion',
              protocol: 'oidc',
              purpose: 'authorization',
              role: 'output',
            },
          },
        },
      ],
      edges: [
        {
          id: 'entry:next->oidc-consent',
          source: 'entry',
          source_handle: 'next',
          target: 'oidc-consent',
        },
        {
          id: 'oidc-consent:accepted->oidc-complete',
          source: 'oidc-consent',
          source_handle: 'accepted',
          target: 'oidc-complete',
        },
      ],
    };

    const response = await adminFlowValidateHandler(createContext({ body: { editor } }));
    const body = await readJson(response);

    expect(body.valid).toBe(false);
    expect(body.errors).toMatchObject([
      {
        level: 'error',
        code: 'missing_consent_policy',
        node_id: 'oidc-consent',
      },
    ]);
  });

  it('treats missing consent policy references in multi-protocol completion branches as warnings', async () => {
    const editor = {
      nodes: [
        { id: 'entry', type: 'entry' },
        {
          id: 'saml-consent',
          type: 'consent',
          config: {
            consent_policy_ref: 'missing-saml-policy',
            completion_block: {
              id: 'saml-attribute-release-completion',
              protocol: 'saml',
              purpose: 'attribute_release',
              role: 'consent',
            },
          },
        },
        {
          id: 'saml-complete',
          type: 'complete',
          config: {
            completion_block: {
              id: 'saml-attribute-release-completion',
              protocol: 'saml',
              purpose: 'attribute_release',
              role: 'output',
            },
          },
        },
        {
          id: 'oidc-consent',
          type: 'consent',
          config: {
            consent_policy_ref: 'missing-oidc-policy',
            completion_block: {
              id: 'oidc-authorization-completion',
              protocol: 'oidc',
              purpose: 'authorization',
              role: 'consent',
            },
          },
        },
        {
          id: 'oidc-complete',
          type: 'complete',
          config: {
            completion_block: {
              id: 'oidc-authorization-completion',
              protocol: 'oidc',
              purpose: 'authorization',
              role: 'output',
            },
          },
        },
      ],
      edges: [
        {
          id: 'entry:next->saml-consent',
          source: 'entry',
          source_handle: 'next',
          target: 'saml-consent',
        },
        {
          id: 'entry:next->oidc-consent',
          source: 'entry',
          source_handle: 'next',
          target: 'oidc-consent',
        },
        {
          id: 'saml-consent:accepted->saml-complete',
          source: 'saml-consent',
          source_handle: 'accepted',
          target: 'saml-complete',
        },
        {
          id: 'oidc-consent:accepted->oidc-complete',
          source: 'oidc-consent',
          source_handle: 'accepted',
          target: 'oidc-complete',
        },
      ],
    };

    const response = await adminFlowValidateHandler(createContext({ body: { editor } }));
    const body = await readJson(response);

    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(body.warnings).toMatchObject([
      {
        level: 'warning',
        code: 'missing_consent_policy',
        node_id: 'saml-consent',
      },
      {
        level: 'warning',
        code: 'missing_consent_policy',
        node_id: 'oidc-consent',
      },
    ]);
  });

  it('accepts session check continue and authenticate output handles', async () => {
    const editor = {
      nodes: [
        { id: 'entry', type: 'entry' },
        { id: 'session-check', type: 'session_check' },
        {
          id: 'authentication',
          type: 'authentication',
          config: {
            authentication_profile_ref: 'default',
            outputs: [{ id: 'passkey', label: 'Passkey' }],
          },
        },
        { id: 'complete', type: 'complete' },
      ],
      edges: [
        {
          id: 'entry:next->session-check',
          source: 'entry',
          source_handle: 'next',
          target: 'session-check',
        },
        {
          id: 'session-check:continue->complete',
          source: 'session-check',
          source_handle: 'continue',
          target: 'complete',
        },
        {
          id: 'session-check:authenticate->authentication',
          source: 'session-check',
          source_handle: 'authenticate',
          target: 'authentication',
        },
        {
          id: 'authentication:passkey->complete',
          source: 'authentication',
          source_handle: 'passkey',
          target: 'complete',
        },
      ],
    };

    const response = await adminFlowValidateHandler(createContext({ body: { editor } }));
    const body = await readJson(response);

    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
    expect(Array.isArray(body.issues)).toBe(true);
    const issueCodes = (body.issues as Array<{ code: string }>).map((issue) => issue.code);
    expect(issueCodes).not.toContain('invalid_output_handle');
  });

  it('increments publish version numbers returned as strings by adapters', async () => {
    seedFlow();
    versions.push({ flow_id: 'flow-1', version_number: '2' });
    mocks.generateId.mockReturnValue('version-3');

    const response = await adminFlowPublishHandler(createContext({ params: { id: 'flow-1' } }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.version).toMatchObject({ id: 'version-3', version_number: 3 });
  });

  it('rebuilds draft runtime when the editor changes without an explicit runtime body', async () => {
    seedFlow({
      draft_runtime_base_json: JSON.stringify({
        flow_kind: 'login',
        flow_id: 'flow-1',
        ui: {
          steps: [{ id: 'entry:step', source_node_id: 'entry', component: 'interaction_context' }],
        },
      }),
    });
    const nextEditor = {
      nodes: [
        { id: 'entry', type: 'entry' },
        { id: 'profile', type: 'profile_form' },
        { id: 'complete', type: 'complete' },
      ],
      edges: [
        { id: 'edge-1', source: 'entry', source_handle: 'next', target: 'profile' },
        { id: 'edge-2', source: 'profile', source_handle: 'submitted', target: 'complete' },
      ],
    };

    const response = await adminFlowUpdateHandler(
      createContext({ params: { id: 'flow-1' }, body: { editor: nextEditor } })
    );

    expect(response.status).toBe(200);
    const runtime = parseRuntimeJson(flows[0]?.draft_runtime_base_json);
    expect(runtime.ui.steps.map((step) => step.source_node_id)).toEqual([
      'entry',
      'profile',
      'complete',
    ]);
  });

  it('sanitizes imported runtime-only and secret-like fields before saving', async () => {
    mocks.generateId.mockReturnValue('flow-imported');

    const response = await adminFlowImportHandler(
      createContext({
        body: {
          schema_version: 'authrim.login_ui.contract.v1',
          mode: 'export',
          runtime: {
            flow_kind: 'login',
            flow_id: 'foreign-flow',
            ui: { steps: [] },
            csrfToken: 'secret-csrf',
            security: { token: 'secret-token' },
          },
          preview: {
            display_name: 'Imported Login',
            slug: 'imported-login',
            template_id: 'oidc-login',
          },
          editor: validEditor,
        },
      })
    );

    expect(response.status).toBe(201);
    expect(flows).toHaveLength(1);
    const saved = JSON.stringify({
      runtime: flows[0].draft_runtime_base_json,
      editor: flows[0].draft_editor_json,
    });
    expect(saved).not.toContain('secret-csrf');
    expect(saved).not.toContain('secret-token');
    expect(flows[0].template_id).toBe('oidc-login');
    expect(parseRuntimeJson(flows[0]?.draft_runtime_base_json)).toMatchObject({
      flow_id: 'flow-imported',
      flow_kind: 'login',
    });
  });

  it('exports template id in the Flow preview metadata', async () => {
    seedFlow({ template_id: 'academic-saml-login' });

    const response = await adminFlowExportHandler(createContext({ params: { id: 'flow-1' } }));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.preview).toMatchObject({
      flow_id: 'flow-1',
      slug: 'login-flow',
      display_name: 'Login Flow',
      template_id: 'academic-saml-login',
    });
  });

  it('only enables assignments to a published Flow of the same kind', async () => {
    seedFlow({ status: 'draft', published_version_id: null });

    const unpublishedResponse = await adminFlowAssignmentUpsertHandler(
      createContext({
        body: {
          target_type: 'oidc_client',
          target_id: 'client-1',
          flow_kind: 'login',
          flow_id: 'flow-1',
          enabled: true,
        },
      })
    );

    expect(unpublishedResponse.status).toBe(400);
    expect(assignments).toHaveLength(0);

    flows[0].status = 'published';
    flows[0].published_version_id = 'version-1';
    const mismatchResponse = await adminFlowAssignmentUpsertHandler(
      createContext({
        body: {
          target_type: 'oidc_client',
          target_id: 'client-1',
          flow_kind: 'registration',
          flow_id: 'flow-1',
          enabled: true,
        },
      })
    );

    expect(mismatchResponse.status).toBe(400);
    expect(assignments).toHaveLength(0);

    const validResponse = await adminFlowAssignmentUpsertHandler(
      createContext({
        body: {
          target_type: 'oidc_client',
          target_id: 'client-1',
          flow_kind: 'login',
          flow_id: 'flow-1',
          enabled: true,
        },
      })
    );

    expect(validResponse.status).toBe(200);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      target_type: 'oidc_client',
      target_id: 'client-1',
      flow_kind: 'login',
      flow_id: 'flow-1',
      enabled: 1,
    });
  });

  it('rejects non-boolean assignment enabled values', async () => {
    seedFlow({ status: 'published', published_version_id: 'version-1' });

    const response = await adminFlowAssignmentUpsertHandler(
      createContext({
        body: {
          target_type: 'oidc_client',
          target_id: 'client-1',
          flow_kind: 'login',
          flow_id: 'flow-1',
          enabled: 'false',
        },
      })
    );

    expect(response.status).toBe(400);
    expect(assignments).toHaveLength(0);
  });

  it('deletes an existing Flow assignment for the selected target and kind', async () => {
    seedFlow({ status: 'published', published_version_id: 'version-1' });
    assignments.push({
      id: 'assignment-1',
      tenant_id: 'tenant-1',
      target_type: 'oidc_client',
      target_id: 'client-1',
      flow_kind: 'login',
      flow_id: 'flow-1',
      enabled: 1,
      created_at: 100,
      updated_at: 100,
    });

    const response = await adminFlowAssignmentDeleteHandler(
      createContext({
        body: {
          target_type: 'oidc_client',
          target_id: 'client-1',
          flow_kind: 'login',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(assignments).toHaveLength(0);
  });

  it('does not delete a Flow after a published version exists', async () => {
    seedFlow({ status: 'published', published_version_id: 'version-1' });

    const response = await adminFlowDeleteHandler(createContext({ params: { id: 'flow-1' } }));

    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({
      error: 'conflict',
      error_description: 'Published Flows cannot be deleted',
    });
  });
});
