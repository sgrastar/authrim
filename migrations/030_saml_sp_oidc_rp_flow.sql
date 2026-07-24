-- Add a published, unassigned login Flow for SAML SP and OIDC RP requests.
-- The authentication path mirrors Login (No consent). After session reuse or
-- authentication, the trusted request protocol selects exactly one End node.

WITH preset(editor_json, runtime_json) AS (
  VALUES (
    '{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}',
    '{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}'
  )
)
INSERT INTO flows (
  id, tenant_id, client_id, profile_id, name, description, graph_definition,
  compiled_plan, version, is_active, is_builtin, created_by, created_at, updated_by,
  updated_at, slug, display_name, kind, status, draft_editor_json, draft_runtime_base_json,
  published_version_id, deleted_at, template_id
)
SELECT
  'flow-saml-sp-oidc-rp', 'default', NULL, 'human-basic',
  'SAML SP/OIDC RP Flow',
  'No-consent login Flow that branches to SAML or OIDC completion after authentication.',
  editor_json, runtime_json, '1.0.0', 1, 0, 'system', __AUTHRIM_NOW_EPOCH_SECONDS__,
  'system', __AUTHRIM_NOW_EPOCH_SECONDS__, 'saml-sp-oidc-rp', 'SAML SP/OIDC RP Flow',
  'login', 'published', editor_json, runtime_json,
  'flow-version-saml-sp-oidc-rp-v1', NULL, 'saml-sp-oidc-rp'
FROM preset
WHERE NOT EXISTS (
  SELECT 1 FROM flows
  WHERE tenant_id = 'default'
    AND (id = 'flow-saml-sp-oidc-rp'
      OR (slug = 'saml-sp-oidc-rp' AND deleted_at IS NULL))
);

INSERT INTO flow_versions (
  id, tenant_id, flow_id, version_number, schema_version, runtime_snapshot_json,
  editor_snapshot_json, validation_result_json, published_by, published_at, created_at
)
SELECT
  'flow-version-saml-sp-oidc-rp-v1', 'default', 'flow-saml-sp-oidc-rp', 1,
  'authrim.login_ui.contract.v1', draft_runtime_base_json, draft_editor_json,
  '{"valid":true,"errors":[],"warnings":[],"issues":[]}',
  'system', __AUTHRIM_NOW_EPOCH_SECONDS__, __AUTHRIM_NOW_EPOCH_SECONDS__
FROM flows
WHERE tenant_id = 'default' AND id = 'flow-saml-sp-oidc-rp'
  AND NOT EXISTS (
    SELECT 1 FROM flow_versions
    WHERE tenant_id = 'default' AND id = 'flow-version-saml-sp-oidc-rp-v1'
  );

-- Rollback (manual):
-- DELETE FROM flow_versions WHERE tenant_id = 'default' AND id = 'flow-version-saml-sp-oidc-rp-v1';
-- DELETE FROM flows WHERE tenant_id = 'default' AND id = 'flow-saml-sp-oidc-rp';
