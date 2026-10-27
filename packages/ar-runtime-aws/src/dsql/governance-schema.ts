import { assertDsqlProtectedIdentitySchema } from './protected-identity-mutations';

// Pinned native Core baseline objects. Constraints/FKs are preserved; triggers are implemented
// by the typed mutation service. A separate event schema permits SELECT/INSERT-only grants.
const definitions = [
  [
    'account_legal_hold_states',
    "CREATE TABLE public.account_legal_hold_states (\n    tenant_id text NOT NULL,\n    account_id text NOT NULL,\n    active_hold_id text,\n    projection_state text DEFAULT 'inactive'::text NOT NULL,\n    projection_generation bigint NOT NULL,\n    updated_at bigint NOT NULL,\n    CONSTRAINT account_legal_hold_states_check CHECK ((((projection_state = 'active'::text) AND (active_hold_id IS NOT NULL)) OR ((projection_state = 'inactive'::text) AND (active_hold_id IS NULL)))),\n    CONSTRAINT account_legal_hold_states_projection_generation_check CHECK ((projection_generation >= 1)),\n    CONSTRAINT account_legal_hold_states_projection_state_check CHECK ((projection_state = ANY (ARRAY['active'::text, 'inactive'::text])))\n);",
    [
      'ALTER TABLE ONLY public.account_legal_hold_states\n    ADD CONSTRAINT account_legal_hold_states_pkey PRIMARY KEY (tenant_id, account_id);',
    ],
    [],
  ],
  [
    'account_support_contexts',
    "CREATE TABLE public.account_support_contexts (\n    tenant_id text NOT NULL,\n    account_id text NOT NULL,\n    context_json jsonb DEFAULT '{\"schema_version\": 1}'::jsonb NOT NULL,\n    version bigint DEFAULT 1 NOT NULL,\n    created_by text NOT NULL,\n    updated_by text NOT NULL,\n    created_at bigint NOT NULL,\n    updated_at bigint NOT NULL,\n    CONSTRAINT account_support_contexts_account_id_check CHECK (((char_length(account_id) >= 1) AND (char_length(account_id) <= 256))),\n    CONSTRAINT account_support_contexts_check CHECK ((updated_at >= created_at)),\n    CONSTRAINT account_support_contexts_context_json_check CHECK (((jsonb_typeof(context_json) = 'object'::text) AND ((octet_length((context_json)::text) >= 20) AND (octet_length((context_json)::text) <= 32768)))),\n    CONSTRAINT account_support_contexts_created_by_check CHECK (((char_length(created_by) >= 1) AND (char_length(created_by) <= 256))),\n    CONSTRAINT account_support_contexts_tenant_id_check CHECK (((char_length(tenant_id) >= 1) AND (char_length(tenant_id) <= 256))),\n    CONSTRAINT account_support_contexts_updated_by_check CHECK (((char_length(updated_by) >= 1) AND (char_length(updated_by) <= 256))),\n    CONSTRAINT account_support_contexts_version_check CHECK ((version >= 1))\n);",
    [
      'ALTER TABLE ONLY public.account_support_contexts\n    ADD CONSTRAINT account_support_contexts_pkey PRIMARY KEY (tenant_id, account_id);',
      'ALTER TABLE ONLY public.account_support_contexts\n    ADD CONSTRAINT account_support_contexts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.identity_accounts(id) ON DELETE CASCADE;',
    ],
    [],
  ],
  [
    'legal_holds',
    "CREATE TABLE public.legal_holds (\n    id text NOT NULL,\n    tenant_id text NOT NULL,\n    subject_type text DEFAULT 'account'::text NOT NULL,\n    subject_id text NOT NULL,\n    state text DEFAULT 'active'::text NOT NULL,\n    reason_code text NOT NULL,\n    case_reference text,\n    expires_at bigint,\n    version bigint DEFAULT 1 NOT NULL,\n    created_by text NOT NULL,\n    created_at bigint NOT NULL,\n    released_by text,\n    released_at bigint,\n    release_reason text,\n    updated_at bigint NOT NULL,\n    CONSTRAINT legal_holds_case_reference_check CHECK (((case_reference IS NULL) OR ((char_length(case_reference) >= 1) AND (char_length(case_reference) <= 256)))),\n    CONSTRAINT legal_holds_check CHECK (((expires_at IS NULL) OR (expires_at >= created_at))),\n    CONSTRAINT legal_holds_check1 CHECK ((((state = 'active'::text) AND (released_by IS NULL) AND (released_at IS NULL) AND (release_reason IS NULL)) OR ((state = ANY (ARRAY['released'::text, 'expired'::text])) AND (released_by IS NOT NULL) AND (released_at IS NOT NULL) AND (release_reason IS NOT NULL)))),\n    CONSTRAINT legal_holds_check2 CHECK (((released_at IS NULL) OR (released_at >= created_at))),\n    CONSTRAINT legal_holds_check3 CHECK ((updated_at >= created_at)),\n    CONSTRAINT legal_holds_created_by_check CHECK (((char_length(created_by) >= 1) AND (char_length(created_by) <= 256))),\n    CONSTRAINT legal_holds_id_check CHECK (((char_length(id) >= 1) AND (char_length(id) <= 256))),\n    CONSTRAINT legal_holds_reason_code_check CHECK (((char_length(reason_code) >= 1) AND (char_length(reason_code) <= 64))),\n    CONSTRAINT legal_holds_release_reason_check CHECK (((release_reason IS NULL) OR ((char_length(release_reason) >= 1) AND (char_length(release_reason) <= 256)))),\n    CONSTRAINT legal_holds_released_by_check CHECK (((released_by IS NULL) OR ((char_length(released_by) >= 1) AND (char_length(released_by) <= 256)))),\n    CONSTRAINT legal_holds_state_check CHECK ((state = ANY (ARRAY['active'::text, 'released'::text, 'expired'::text]))),\n    CONSTRAINT legal_holds_subject_id_check CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 256))),\n    CONSTRAINT legal_holds_subject_type_check CHECK ((subject_type = 'account'::text)),\n    CONSTRAINT legal_holds_tenant_id_check CHECK (((char_length(tenant_id) >= 1) AND (char_length(tenant_id) <= 256))),\n    CONSTRAINT legal_holds_version_check CHECK ((version >= 1))\n);",
    ['ALTER TABLE ONLY public.legal_holds\n    ADD CONSTRAINT legal_holds_pkey PRIMARY KEY (id);'],
    [
      'CREATE INDEX idx_legal_holds_account_history ON public.legal_holds USING btree (tenant_id, subject_id, created_at DESC, id DESC);',
      "CREATE INDEX idx_legal_holds_expiry ON public.legal_holds USING btree (state, expires_at, tenant_id, id) WHERE ((state = 'active'::text) AND (expires_at IS NOT NULL));",
      "CREATE UNIQUE INDEX idx_legal_holds_one_active_account ON public.legal_holds USING btree (tenant_id, subject_type, subject_id) WHERE (state = 'active'::text);",
    ],
  ],
  [
    'legal_hold_events',
    "CREATE TABLE public.legal_hold_events (\n    event_id text NOT NULL,\n    hold_id text NOT NULL,\n    tenant_id text NOT NULL,\n    account_id text NOT NULL,\n    event_type text NOT NULL,\n    hold_version bigint NOT NULL,\n    projection_generation bigint NOT NULL,\n    actor_id text NOT NULL,\n    reason_code text NOT NULL,\n    case_reference text,\n    effective_at bigint NOT NULL,\n    created_at bigint NOT NULL,\n    CONSTRAINT legal_hold_events_actor_id_check CHECK (((char_length(actor_id) >= 1) AND (char_length(actor_id) <= 256))),\n    CONSTRAINT legal_hold_events_case_reference_check CHECK (((case_reference IS NULL) OR ((char_length(case_reference) >= 1) AND (char_length(case_reference) <= 256)))),\n    CONSTRAINT legal_hold_events_check CHECK ((created_at >= effective_at)),\n    CONSTRAINT legal_hold_events_event_id_check CHECK (((char_length(event_id) >= 1) AND (char_length(event_id) <= 256))),\n    CONSTRAINT legal_hold_events_event_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'extended'::text, 'released'::text, 'expired'::text]))),\n    CONSTRAINT legal_hold_events_hold_version_check CHECK ((hold_version >= 1)),\n    CONSTRAINT legal_hold_events_projection_generation_check CHECK ((projection_generation >= 1)),\n    CONSTRAINT legal_hold_events_reason_code_check CHECK (((char_length(reason_code) >= 1) AND (char_length(reason_code) <= 64)))\n);",
    [
      'ALTER TABLE ONLY public.legal_hold_events\n    ADD CONSTRAINT legal_hold_events_hold_id_hold_version_key UNIQUE (hold_id, hold_version);',
      'ALTER TABLE ONLY public.legal_hold_events\n    ADD CONSTRAINT legal_hold_events_pkey PRIMARY KEY (event_id);',
      'ALTER TABLE ONLY public.legal_hold_events\n    ADD CONSTRAINT legal_hold_events_tenant_id_account_id_projection_generatio_key UNIQUE (tenant_id, account_id, projection_generation);',
      'ALTER TABLE ONLY public.legal_hold_events\n    ADD CONSTRAINT legal_hold_events_hold_id_fkey FOREIGN KEY (hold_id) REFERENCES public.legal_holds(id) ON DELETE CASCADE;',
    ],
    [
      'CREATE INDEX idx_legal_hold_events_account ON public.legal_hold_events USING btree (tenant_id, account_id, created_at DESC, event_id DESC);',
    ],
  ],
  [
    'legal_hold_projection_outbox',
    "CREATE TABLE public.legal_hold_projection_outbox (\n    operation_id text NOT NULL,\n    tenant_id text NOT NULL,\n    hold_id text NOT NULL,\n    account_id text NOT NULL,\n    projection_generation bigint NOT NULL,\n    hold_version bigint NOT NULL,\n    projection_state text NOT NULL,\n    status text DEFAULT 'pending'::text NOT NULL,\n    attempt_count bigint DEFAULT 0 NOT NULL,\n    next_attempt_at bigint NOT NULL,\n    lease_owner text,\n    lease_expires_at bigint,\n    last_error_code text,\n    created_at bigint NOT NULL,\n    updated_at bigint NOT NULL,\n    completed_at bigint,\n    CONSTRAINT legal_hold_projection_outbox_attempt_count_check CHECK ((attempt_count >= 0)),\n    CONSTRAINT legal_hold_projection_outbox_check CHECK ((((lease_owner IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),\n    CONSTRAINT legal_hold_projection_outbox_check1 CHECK ((((status = 'succeeded'::text) AND (completed_at IS NOT NULL)) OR (status <> 'succeeded'::text))),\n    CONSTRAINT legal_hold_projection_outbox_check2 CHECK ((updated_at >= created_at)),\n    CONSTRAINT legal_hold_projection_outbox_hold_version_check CHECK ((hold_version >= 1)),\n    CONSTRAINT legal_hold_projection_outbox_operation_id_check CHECK (((char_length(operation_id) >= 1) AND (char_length(operation_id) <= 256))),\n    CONSTRAINT legal_hold_projection_outbox_projection_generation_check CHECK ((projection_generation >= 1)),\n    CONSTRAINT legal_hold_projection_outbox_projection_state_check CHECK ((projection_state = ANY (ARRAY['active'::text, 'inactive'::text]))),\n    CONSTRAINT legal_hold_projection_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'blocked'::text])))\n);",
    [
      'ALTER TABLE ONLY public.legal_hold_projection_outbox\n    ADD CONSTRAINT legal_hold_projection_outbox_hold_id_hold_version_key UNIQUE (hold_id, hold_version);',
      'ALTER TABLE ONLY public.legal_hold_projection_outbox\n    ADD CONSTRAINT legal_hold_projection_outbox_pkey PRIMARY KEY (operation_id);',
      'ALTER TABLE ONLY public.legal_hold_projection_outbox\n    ADD CONSTRAINT legal_hold_projection_outbox_tenant_id_account_id_projectio_key UNIQUE (tenant_id, account_id, projection_generation);',
      'ALTER TABLE ONLY public.legal_hold_projection_outbox\n    ADD CONSTRAINT legal_hold_projection_outbox_hold_id_fkey FOREIGN KEY (hold_id) REFERENCES public.legal_holds(id) ON DELETE CASCADE;',
    ],
    [
      'CREATE INDEX idx_legal_hold_projection_outbox_runnable ON public.legal_hold_projection_outbox USING btree (status, next_attempt_at, tenant_id, operation_id);',
    ],
  ],
] as const;

export function createDsqlGovernanceSchemaPlan(coreSchema: string, eventSchema: string) {
  assertDsqlProtectedIdentitySchema(coreSchema);
  assertDsqlProtectedIdentitySchema(eventSchema);
  if (coreSchema === eventSchema) throw new Error('dsql_governance_event_schema_must_be_separate');
  const qualify = (sql: string) =>
    sql.replace(
      /public\.(\w+)/gu,
      (_, name: string) => `"${name === 'legal_hold_events' ? eventSchema : coreSchema}"."${name}"`
    );
  const tables: { name: string; sql: string }[] = definitions
    .map(([name, sql, constraints]) => {
      const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
      const inline = constraints.map((item) => item.slice(item.indexOf('ADD CONSTRAINT ') + 4, -1));
      return {
        name,
        sql: qualify(
          `CREATE TABLE public.${name} (${body}${inline.length ? ',\n' + inline.join(',\n') : ''})`
        ),
      };
    })
    .sort((a, b) => (a.name === 'legal_holds' ? -1 : 0) - (b.name === 'legal_holds' ? -1 : 0));
  tables.push({
    name: 'authrim_governance_mutation_receipts',
    sql: `CREATE TABLE "${coreSchema}"."authrim_governance_mutation_receipts" (
    tenant_id TEXT NOT NULL, operation_id TEXT NOT NULL, input_sha256 TEXT NOT NULL,
    source_json TEXT NOT NULL, applied BOOLEAN NOT NULL, created_at BIGINT NOT NULL,
    PRIMARY KEY(tenant_id,operation_id))`,
  });
  const indexes = definitions.flatMap(([table, , , items]) =>
    items.map((sql) => {
      const name = sql.match(/INDEX (\w+)/u)?.[1] ?? '';
      // DSQL rejects DESC physical index keys. These two nonunique history access paths
      // use default ordering; query ORDER BY stays unchanged. Performance parity is unverified.
      const defaultOrderHistoryIndex =
        sql.startsWith('CREATE INDEX ') &&
        (name === 'idx_legal_holds_account_history' || name === 'idx_legal_hold_events_account');
      const nativeSql = defaultOrderHistoryIndex ? sql.replace(/ DESC(?=[,)])/gu, '') : sql;
      return {
        table,
        name,
        sql: qualify(nativeSql.replace(' INDEX ', ' INDEX ASYNC ').replace(' USING btree ', ' ')),
      };
    })
  );
  return {
    scope: 'protected-account-governance' as const,
    fullRuntimeReady: false as const,
    coreSchema,
    eventSchema,
    tables,
    indexes,
    requiredRuntimeEventPrivileges: ['USAGE', 'SELECT', 'INSERT'] as const,
    // Cascading a parent delete can bypass the child's explicit DELETE privilege.
    // These restrictions must be verified along with event-schema privileges at admission.
    forbiddenRuntimeParentPrivileges: {
      legal_holds: ['DELETE', 'TRUNCATE', 'OWNERSHIP'] as const,
      identity_accounts: ['DELETE', 'TRUNCATE', 'OWNERSHIP'] as const,
    },
    forbiddenRuntimeEventPrivileges: [
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'CREATE',
      'OWNERSHIP',
    ] as const,
  };
}
