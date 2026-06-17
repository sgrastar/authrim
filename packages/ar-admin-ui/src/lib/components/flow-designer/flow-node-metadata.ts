import type { GraphNodeType } from '$lib/api/admin-flows';

export interface FlowNodeMetadata {
	icon: string;
	color: string;
}

const FLOW_NODE_METADATA: Partial<Record<GraphNodeType, FlowNodeMetadata>> = {
	start: { icon: '▶', color: 'var(--flow-node-color-start)' },
	end: { icon: '●', color: 'var(--flow-node-color-end)' },
	goto: { icon: '↪', color: 'var(--flow-node-color-muted)' },

	check_session: { icon: '🔍', color: 'var(--flow-node-color-check)' },
	check_auth_level: { icon: '📊', color: 'var(--flow-node-color-check-alt)' },
	check_first_login: { icon: '🆕', color: 'var(--flow-node-color-check-deep)' },
	check_user_attribute: { icon: '👁️', color: 'var(--flow-node-color-auth)' },
	check_context: { icon: '📍', color: 'var(--flow-node-color-check-alt)' },
	check_risk: { icon: '⚠️', color: 'var(--flow-node-color-risk)' },

	auth_method_select: { icon: '🔑', color: 'var(--flow-node-color-selection)' },
	login_method_select: { icon: '🚪', color: 'var(--flow-node-color-selection-alt)' },
	identifier: { icon: '👤', color: 'var(--flow-node-color-consent)' },
	profile_input: { icon: '📋', color: 'var(--flow-node-color-side-effect)' },
	custom_form: { icon: '📄', color: 'var(--flow-node-color-side-effect)' },
	information: { icon: 'ℹ️', color: 'var(--flow-node-color-muted)' },
	challenge: { icon: '🎯', color: 'var(--flow-node-color-warning)' },

	login: { icon: '🔐', color: 'var(--flow-node-color-auth)' },
	mfa: { icon: '🛡️', color: 'var(--flow-node-color-warning)' },
	register: { icon: '📝', color: 'var(--flow-node-color-end)' },

	consent: { icon: '✓', color: 'var(--flow-node-color-consent)' },
	check_consent_status: { icon: '✔️', color: 'var(--flow-node-color-side-effect)' },
	record_consent: { icon: '📜', color: 'var(--flow-node-color-side-effect)' },

	resolve_tenant: { icon: '🏢', color: 'var(--flow-node-color-check-alt)' },
	resolve_org: { icon: '🏛️', color: 'var(--flow-node-color-check-deep)' },
	resolve_policy: { icon: '📋', color: 'var(--flow-node-color-auth)' },

	issue_tokens: { icon: '🎫', color: 'var(--flow-node-color-start)' },
	refresh_session: { icon: '🔄', color: 'var(--flow-node-color-end)' },
	revoke_session: { icon: '🚫', color: 'var(--flow-node-color-error)' },
	bind_device: { icon: '📱', color: 'var(--flow-node-color-warning)' },
	link_account: { icon: '🔗', color: 'var(--flow-node-color-logic)' },

	redirect: { icon: '↗️', color: 'var(--flow-node-color-side-effect)' },
	webhook: { icon: '🌐', color: 'var(--flow-node-color-side-effect)' },
	event_emit: { icon: '📡', color: 'var(--flow-node-color-session)' },
	email_send: { icon: '📧', color: 'var(--flow-node-color-check-deep)' },
	sms_send: { icon: '💬', color: 'var(--flow-node-color-check-alt)' },
	push_notify: { icon: '🔔', color: 'var(--flow-node-color-check)' },

	decision: { icon: '⋔', color: 'var(--flow-node-color-logic)' },
	switch: { icon: '🔀', color: 'var(--flow-node-color-switch)' },
	policy_check: { icon: '🛡️', color: 'var(--flow-node-color-check-alt)' },
	error: { icon: '✕', color: 'var(--flow-node-color-error)' },
	log: { icon: '📋', color: 'var(--flow-node-color-muted)' },

	auth_method: { icon: '🔑', color: 'var(--flow-node-color-check-alt)' },
	user_input: { icon: '📋', color: 'var(--flow-node-color-selection-alt)' },
	wait_input: { icon: '⏳', color: 'var(--flow-node-color-muted)' },
	condition: { icon: '⋔', color: 'var(--flow-node-color-logic)' },
	check_user: { icon: '👁️', color: 'var(--flow-node-color-check-deep)' },
	risk_check: { icon: '⚠️', color: 'var(--flow-node-color-risk)' },
	set_variable: { icon: '📝', color: 'var(--flow-node-color-session)' },
	call_api: { icon: '🌐', color: 'var(--flow-node-color-side-effect)' },
	send_notification: { icon: '📧', color: 'var(--flow-node-color-check-deep)' }
};

const DEFAULT_NODE_METADATA: FlowNodeMetadata = {
	icon: '⚡',
	color: 'var(--flow-node-color-muted)'
};

export function getFlowNodeMetadata(type: GraphNodeType): FlowNodeMetadata {
	return FLOW_NODE_METADATA[type] ?? DEFAULT_NODE_METADATA;
}

export function getFlowNodeColor(type: GraphNodeType | string | undefined): string {
	if (!type) return DEFAULT_NODE_METADATA.color;
	return FLOW_NODE_METADATA[type as GraphNodeType]?.color ?? DEFAULT_NODE_METADATA.color;
}
