-- =============================================================================
-- Authrim Core Migration 017: Flow Runtime
-- Consolidated for fresh Authrim installs from migrations/026_flow_runtime_contract.sql, migrations/027_flow_interaction_context.sql, migrations/031_flow_template_id.sql, migrations/033_unique_flow_assignments.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/026_flow_runtime_contract.sql
-- -----------------------------------------------------------------------------

-- New Flow runtime contract storage.
-- Extends the legacy flows table and adds published versions, assignments,
-- runtime interaction state, and Flow-specific audit events.

ALTER TABLE flows ADD COLUMN slug TEXT;
ALTER TABLE flows ADD COLUMN display_name TEXT;
ALTER TABLE flows ADD COLUMN kind TEXT NOT NULL DEFAULT 'login';
ALTER TABLE flows ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE flows ADD COLUMN draft_editor_json TEXT;
ALTER TABLE flows ADD COLUMN draft_runtime_base_json TEXT;
ALTER TABLE flows ADD COLUMN published_version_id TEXT;
ALTER TABLE flows ADD COLUMN deleted_at INTEGER;

UPDATE flows
SET
  slug = COALESCE(slug, id),
  display_name = COALESCE(display_name, name),
  draft_editor_json = COALESCE(draft_editor_json, graph_definition),
  draft_runtime_base_json = COALESCE(draft_runtime_base_json, compiled_plan);

CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, flow_id, version_number)
);

CREATE TABLE flow_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (
    target_type IN ('tenant', 'oidc_client', 'saml_sp', 'credential_profile')
  ),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp', 'credential_profile') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);

CREATE TABLE flow_interactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'active', 'completed', 'expired', 'failed')),
  current_node_id TEXT,
  current_step_id TEXT,
  contract_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
);

CREATE TABLE flow_interaction_steps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'waiting_input', 'processing', 'completed', 'skipped', 'failed')
  ),
  selected_handle TEXT,
  state_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
);

CREATE TABLE flow_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  node_id TEXT,
  branch_handle_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  contract_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_flows_runtime_slug
  ON flows(tenant_id, slug, deleted_at);

CREATE INDEX idx_flows_runtime_kind_status
  ON flows(tenant_id, kind, status);

CREATE INDEX idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number);

CREATE INDEX idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at);

CREATE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, target_type, flow_kind, target_id);

CREATE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind);

CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);

CREATE INDEX idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id);

CREATE INDEX idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at);

CREATE INDEX idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at);

CREATE INDEX idx_flow_interactions_state_updated
  ON flow_interactions(tenant_id, state, updated_at, id);

CREATE INDEX idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id);

CREATE INDEX idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state);

CREATE INDEX idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at);

CREATE INDEX idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at);

-- -----------------------------------------------------------------------------
-- Source: migrations/027_flow_interaction_context.sql
-- -----------------------------------------------------------------------------

-- Store request-time context for Flow runtime condition evaluation.

ALTER TABLE flow_interactions ADD COLUMN context_json TEXT;

-- -----------------------------------------------------------------------------
-- Source: migrations/031_flow_template_id.sql
-- -----------------------------------------------------------------------------

-- Store the source template for saved Flow drafts.
-- Template labels and descriptions are localized at display time unless admins
-- override the Flow description explicitly.

ALTER TABLE flows ADD COLUMN template_id TEXT;

CREATE INDEX IF NOT EXISTS idx_flows_template_id ON flows(tenant_id, template_id);

-- Seed tenant-default no-consent Flows for fresh installs so Login UI can run
-- without first creating and assigning a Flow from Admin UI.
INSERT INTO flows (
  id, tenant_id, client_id, profile_id, name, description, graph_definition,
  compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
  updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
  published_version_id, deleted_at, template_id
)
SELECT
  'flow-default-login-no-consent',
  'default',
  NULL,
  'human-basic',
  'Login (No consent)',
  NULL,
  '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}',
  '{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}',
  '1.0.0',
  1,
  0,
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  'default-login-no-consent',
  'Login (No consent)',
  'login',
  'published',
  '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}',
  '{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}',
  'flow-version-default-login-no-consent-v1',
  NULL,
  'default-login-no-consent'
WHERE NOT EXISTS (
  SELECT 1 FROM flows
  WHERE tenant_id = 'default'
    AND (
      id = 'flow-default-login-no-consent'
      OR (slug = 'default-login-no-consent' AND deleted_at IS NULL)
    )
);

INSERT INTO flows (
  id, tenant_id, client_id, profile_id, name, description, graph_definition,
  compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
  updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
  published_version_id, deleted_at, template_id
)
SELECT
  'flow-default-registration-no-consent',
  'default',
  NULL,
  'human-basic',
  'Registration (No consent)',
  NULL,
  '{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}',
  '{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}',
  '1.0.0',
  1,
  0,
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  'default-registration-no-consent',
  'Registration (No consent)',
  'registration',
  'published',
  '{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}',
  '{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}',
  'flow-version-default-registration-no-consent-v1',
  NULL,
  'default-registration-no-consent'
WHERE NOT EXISTS (
  SELECT 1 FROM flows
  WHERE tenant_id = 'default'
    AND (
      id = 'flow-default-registration-no-consent'
      OR (slug = 'default-registration-no-consent' AND deleted_at IS NULL)
    )
);

INSERT INTO flow_versions (
  id, tenant_id, flow_id, version_number, schema_version, runtime_snapshot_json,
  editor_snapshot_json, validation_result_json, published_by, published_at, created_at
)
SELECT
  'flow-version-default-login-no-consent-v1',
  'default',
  'flow-default-login-no-consent',
  1,
  'authrim.login_ui.contract.v1',
  draft_runtime_base_json,
  draft_editor_json,
  '{"valid":true,"errors":[],"warnings":[],"issues":[]}',
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
FROM flows
WHERE tenant_id = 'default' AND id = 'flow-default-login-no-consent'
  AND NOT EXISTS (
    SELECT 1 FROM flow_versions
    WHERE tenant_id = 'default' AND id = 'flow-version-default-login-no-consent-v1'
  );

INSERT INTO flow_versions (
  id, tenant_id, flow_id, version_number, schema_version, runtime_snapshot_json,
  editor_snapshot_json, validation_result_json, published_by, published_at, created_at
)
SELECT
  'flow-version-default-registration-no-consent-v1',
  'default',
  'flow-default-registration-no-consent',
  1,
  'authrim.login_ui.contract.v1',
  draft_runtime_base_json,
  draft_editor_json,
  '{"valid":true,"errors":[],"warnings":[],"issues":[]}',
  'system',
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
FROM flows
WHERE tenant_id = 'default' AND id = 'flow-default-registration-no-consent'
  AND NOT EXISTS (
    SELECT 1 FROM flow_versions
    WHERE tenant_id = 'default' AND id = 'flow-version-default-registration-no-consent-v1'
  );

INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, enabled, created_at, updated_at
)
SELECT
  'flow-assignment-default-login',
  'default',
  'tenant',
  NULL,
  'login',
  'flow-default-login-no-consent',
  1,
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM flow_assignments
  WHERE tenant_id = 'default'
    AND (
      id = 'flow-assignment-default-login'
      OR (target_type = 'tenant' AND target_id IS NULL AND flow_kind = 'login')
    )
);

INSERT INTO flow_assignments (
  id, tenant_id, target_type, target_id, flow_kind, flow_id, enabled, created_at, updated_at
)
SELECT
  'flow-assignment-default-registration',
  'default',
  'tenant',
  NULL,
  'registration',
  'flow-default-registration-no-consent',
  1,
  __AUTHRIM_NOW_EPOCH_SECONDS__,
  __AUTHRIM_NOW_EPOCH_SECONDS__
WHERE NOT EXISTS (
  SELECT 1 FROM flow_assignments
  WHERE tenant_id = 'default'
    AND (
      id = 'flow-assignment-default-registration'
      OR (target_type = 'tenant' AND target_id IS NULL AND flow_kind = 'registration')
    )
);

-- -----------------------------------------------------------------------------
-- Source: migrations/033_unique_flow_assignments.sql
-- -----------------------------------------------------------------------------

-- Keep one Flow assignment for each target and Flow kind.
-- If duplicate rows already exist, retain the most recently updated row before adding uniqueness.

DELETE FROM flow_assignments
WHERE EXISTS (
  SELECT 1
  FROM flow_assignments newer
  WHERE newer.tenant_id = flow_assignments.tenant_id
    AND newer.target_type = flow_assignments.target_type
    AND (
      (newer.target_id IS NULL AND flow_assignments.target_id IS NULL)
      OR newer.target_id = flow_assignments.target_id
    )
    AND newer.flow_kind = flow_assignments.flow_kind
    AND (
      newer.updated_at > flow_assignments.updated_at
      OR (
        newer.updated_at = flow_assignments.updated_at
        AND newer.created_at > flow_assignments.created_at
      )
      OR (
        newer.updated_at = flow_assignments.updated_at
        AND newer.created_at = flow_assignments.created_at
        AND newer.id > flow_assignments.id
      )
    )
);

DROP INDEX IF EXISTS idx_flow_assignments_tenant_default_unique;
DROP INDEX IF EXISTS idx_flow_assignments_target_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, COALESCE(target_id, ''), flow_kind);
