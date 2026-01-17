<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type Flow,
		type GraphNode,
		type GraphEdge,
		type GraphDefinition,
		type GraphNodeType,
		canEditFlow
	} from '$lib/api/admin-flows';
	import { FlowCanvas, NodePalette, NodeConfigModal } from '$lib/components/flow-designer';

	let flow: Flow | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let hasChanges = $state(false);

	// Graph state
	let nodes = $state<GraphNode[]>([]);
	let edges = $state<GraphEdge[]>([]);
	let configModalNodeId = $state<string | null>(null);

	const flowId = $derived($page.params.id ?? '');
	const configModalNode = $derived(
		configModalNodeId ? nodes.find((n) => n.id === configModalNodeId) || null : null
	);

	async function loadFlow() {
		if (!flowId) return;
		loading = true;
		error = '';

		try {
			const response = await adminFlowsAPI.get(flowId);
			flow = response.flow;

			if (flow.graph_definition) {
				nodes = [...flow.graph_definition.nodes];
				edges = [...flow.graph_definition.edges];
			}

			if (!canEditFlow(flow)) {
				error = 'This flow is read-only and cannot be edited.';
			}
		} catch (err) {
			console.error('Failed to load flow:', err);
			error = err instanceof Error ? err.message : 'Failed to load flow';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadFlow();
	});

	function handleNodesChange(newNodes: GraphNode[]) {
		nodes = newNodes;
		hasChanges = true;
	}

	function handleEdgesChange(newEdges: GraphEdge[]) {
		edges = newEdges;
		hasChanges = true;
	}

	function handleNodeConfig(nodeId: string) {
		configModalNodeId = nodeId;
	}

	function handleCloseConfigModal() {
		configModalNodeId = null;
	}

	function handleConfigSave(
		nodeId: string,
		updates: { label: string; config: Record<string, unknown> }
	) {
		nodes = nodes.map((node) => {
			if (node.id === nodeId) {
				return {
					...node,
					data: { ...node.data, label: updates.label, config: updates.config }
				};
			}
			return node;
		});
		hasChanges = true;
	}

	function handleDeleteNode(nodeId: string) {
		// Remove the node
		nodes = nodes.filter((n) => n.id !== nodeId);
		// Remove connected edges
		edges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
		// Close config modal if this node was being configured
		if (configModalNodeId === nodeId) {
			configModalNodeId = null;
		}
		hasChanges = true;
	}

	function handleAddNode(type: GraphNodeType, position: { x: number; y: number }) {
		const metadata = getNodeMetadata(type);
		const newNode: GraphNode = {
			id: `${type}-${Date.now()}`,
			type,
			position,
			data: {
				label: getDefaultLabel(type),
				icon: metadata.icon,
				color: metadata.color,
				config: getDefaultConfig(type)
			}
		};
		nodes = [...nodes, newNode];
		hasChanges = true;
	}

	function getDefaultLabel(type: GraphNodeType): string {
		const labels: Partial<Record<GraphNodeType, string>> = {
			// 1. Control Nodes
			start: 'Start',
			end: 'End',
			goto: 'Goto',
			// 2. Check Nodes
			check_session: 'Check Session',
			check_auth_level: 'Check Auth Level',
			check_first_login: 'Check First Login',
			check_user_attribute: 'Check User Attribute',
			check_context: 'Check Context',
			check_risk: 'Check Risk',
			// 3. Selection Nodes
			auth_method_select: 'Auth Method Select',
			login_method_select: 'Login Method Select',
			identifier: 'Identifier Input',
			profile_input: 'Profile Input',
			custom_form: 'Custom Form',
			information: 'Information',
			challenge: 'Challenge',
			// 4. Authentication Nodes
			login: 'Login',
			mfa: 'MFA',
			register: 'Register',
			// 5. Consent Nodes
			consent: 'Consent',
			check_consent_status: 'Check Consent Status',
			record_consent: 'Record Consent',
			// 6. Resolve Nodes
			resolve_tenant: 'Resolve Tenant',
			resolve_org: 'Resolve Organization',
			resolve_policy: 'Resolve Policy',
			// 7. Session Nodes
			issue_tokens: 'Issue Tokens',
			refresh_session: 'Refresh Session',
			revoke_session: 'Revoke Session',
			bind_device: 'Bind Device',
			link_account: 'Link Account',
			// 8. Side Effect Nodes
			redirect: 'Redirect',
			webhook: 'Webhook',
			event_emit: 'Emit Event',
			email_send: 'Send Email',
			sms_send: 'Send SMS',
			push_notify: 'Push Notification',
			// 9. Logic Nodes
			decision: 'Decision',
			switch: 'Switch',
			// 10. Policy Nodes
			policy_check: 'Policy Check',
			// 11. Error Nodes
			error: 'Error',
			log: 'Log',
			// Legacy (deprecated)
			auth_method: 'Authentication',
			user_input: 'User Input',
			wait_input: 'Wait Input',
			condition: 'Condition',
			check_user: 'Check User',
			risk_check: 'Risk Check',
			set_variable: 'Set Variable',
			call_api: 'Call API',
			send_notification: 'Send Notification'
		};
		return labels[type] || type;
	}

	function getDefaultConfig(type: GraphNodeType): Record<string, unknown> {
		switch (type) {
			// 1. Control Nodes
			case 'start':
				return {};
			case 'end':
				return {};
			case 'goto':
				return { target: '' };

			// 2. Check Nodes (fact-based)
			case 'check_session':
				return { fact: 'session.authenticated' };
			case 'check_auth_level':
				return { required_level: 'basic' };
			case 'check_first_login':
				return {};
			case 'check_user_attribute':
				return { attribute: 'email_verified', expected: true };
			case 'check_context':
				return { fact: 'context.is_new_device' };
			case 'check_risk':
				return { threshold: 'medium' };

			// 3. Selection Nodes
			case 'auth_method_select':
				return { available_methods: ['password', 'passkey', 'email_otp'] };
			case 'login_method_select':
				return { available_methods: ['email', 'social'] };
			case 'identifier':
				return { type: 'email' };
			case 'profile_input':
				return { fields: ['display_name'] };
			case 'custom_form':
				return { fields: [], validation: {} };
			case 'information':
				return { template: 'welcome', actions: ['continue'] };
			case 'challenge':
				return { type: 'captcha' };

			// 4. Authentication Nodes
			case 'login':
				return { method: 'password', remember_me: true };
			case 'mfa':
				return { factors: ['totp', 'email_otp'] };
			case 'register':
				return { require_email_verification: true, auto_login: true };

			// 5. Consent Nodes
			case 'consent':
				return { consents: ['terms'] };
			case 'check_consent_status':
				return { consent_type: 'terms' };
			case 'record_consent':
				return { consent_type: 'terms', granted: true };

			// 6. Resolve Nodes
			case 'resolve_tenant':
				return { source: 'email_domain' };
			case 'resolve_org':
				return { source: 'user_attribute' };
			case 'resolve_policy':
				return { policy_type: 'authentication' };

			// 7. Session Nodes
			case 'issue_tokens':
				return { include_refresh: true };
			case 'refresh_session':
				return {};
			case 'revoke_session':
				return { scope: 'current' };
			case 'bind_device':
				return { trust_level: 'verified' };
			case 'link_account':
				return { provider: 'google' };

			// 8. Side Effect Nodes
			case 'redirect':
				return { to: 'post_login' };
			case 'webhook':
				return { url: '', method: 'POST' };
			case 'event_emit':
				return { event_type: 'user.login' };
			case 'email_send':
				return { template: 'welcome' };
			case 'sms_send':
				return { template: 'verification' };
			case 'push_notify':
				return { template: 'login_alert' };

			// 9. Logic Nodes
			case 'decision':
				return { condition: 'true' };
			case 'switch':
				return { key: 'user.role', cases: {} };

			// 10. Policy Nodes
			case 'policy_check':
				return { policy_id: '' };

			// 11. Error Nodes
			case 'error':
				return { reason: 'unknown_error', allow_retry: false };
			case 'log':
				return { level: 'info', message: '' };

			// Legacy (deprecated)
			case 'auth_method':
				return { methods: ['password'] };
			case 'user_input':
				return { fields: [] };
			case 'wait_input':
				return { fields: ['input'] };
			case 'condition':
				return { key: 'prevNode.success', operator: 'isTrue' };
			case 'check_user':
				return { fact: 'user.email_verified' };
			case 'risk_check':
				return { fact: 'context.high_risk' };
			case 'set_variable':
				return { name: 'step', value: 'completed' };
			case 'call_api':
				return { url: '', method: 'GET' };
			case 'send_notification':
				return { type: 'email', template: 'welcome' };

			default:
				return {};
		}
	}

	// Get default icon and color for node type
	function getNodeMetadata(type: GraphNodeType): { icon: string; color: string } {
		const metadata: Partial<Record<GraphNodeType, { icon: string; color: string }>> = {
			// 1. Control Nodes
			start: { icon: '▶', color: '#22c55e' },
			end: { icon: '●', color: '#10b981' },
			goto: { icon: '↪', color: '#64748b' },
			// 2. Check Nodes
			check_session: { icon: '🔍', color: '#a855f7' },
			check_auth_level: { icon: '📊', color: '#8b5cf6' },
			check_first_login: { icon: '🆕', color: '#7c3aed' },
			check_user_attribute: { icon: '👁️', color: '#6366f1' },
			check_context: { icon: '📍', color: '#4f46e5' },
			check_risk: { icon: '⚠️', color: '#dc2626' },
			// 3. Selection Nodes
			auth_method_select: { icon: '🔑', color: '#3b82f6' },
			login_method_select: { icon: '🚪', color: '#0ea5e9' },
			identifier: { icon: '👤', color: '#06b6d4' },
			profile_input: { icon: '📋', color: '#0891b2' },
			custom_form: { icon: '📄', color: '#0284c7' },
			information: { icon: 'ℹ️', color: '#64748b' },
			challenge: { icon: '🎯', color: '#f59e0b' },
			// 4. Authentication Nodes
			login: { icon: '🔐', color: '#6366f1' },
			mfa: { icon: '🛡️', color: '#f59e0b' },
			register: { icon: '📝', color: '#10b981' },
			// 5. Consent Nodes
			consent: { icon: '✓', color: '#06b6d4' },
			check_consent_status: { icon: '✔️', color: '#0891b2' },
			record_consent: { icon: '📜', color: '#0284c7' },
			// 6. Resolve Nodes
			resolve_tenant: { icon: '🏢', color: '#8b5cf6' },
			resolve_org: { icon: '🏛️', color: '#7c3aed' },
			resolve_policy: { icon: '📋', color: '#6366f1' },
			// 7. Session Nodes
			issue_tokens: { icon: '🎫', color: '#22c55e' },
			refresh_session: { icon: '🔄', color: '#10b981' },
			revoke_session: { icon: '🚫', color: '#ef4444' },
			bind_device: { icon: '📱', color: '#f59e0b' },
			link_account: { icon: '🔗', color: '#ec4899' },
			// 8. Side Effect Nodes
			redirect: { icon: '↗️', color: '#0891b2' },
			webhook: { icon: '🌐', color: '#0284c7' },
			event_emit: { icon: '📡', color: '#059669' },
			email_send: { icon: '📧', color: '#7c3aed' },
			sms_send: { icon: '💬', color: '#8b5cf6' },
			push_notify: { icon: '🔔', color: '#a855f7' },
			// 9. Logic Nodes
			decision: { icon: '⋔', color: '#ec4899' },
			switch: { icon: '🔀', color: '#f43f5e' },
			// 10. Policy Nodes
			policy_check: { icon: '🛡️', color: '#4f46e5' },
			// 11. Error Nodes
			error: { icon: '✕', color: '#ef4444' },
			log: { icon: '📋', color: '#64748b' },
			// Legacy (deprecated)
			auth_method: { icon: '🔑', color: '#8b5cf6' },
			user_input: { icon: '📋', color: '#0ea5e9' },
			wait_input: { icon: '⏳', color: '#64748b' },
			condition: { icon: '⋔', color: '#ec4899' },
			check_user: { icon: '👁️', color: '#7c3aed' },
			risk_check: { icon: '⚠️', color: '#dc2626' },
			set_variable: { icon: '📝', color: '#059669' },
			call_api: { icon: '🌐', color: '#0284c7' },
			send_notification: { icon: '📧', color: '#7c3aed' }
		};
		return metadata[type] || { icon: '⚡', color: '#6b7280' };
	}

	async function handleSave() {
		if (!flow || !canEditFlow(flow)) return;

		saving = true;
		saveError = '';

		try {
			const graphDefinition: GraphDefinition = {
				id: flow.id,
				flowVersion: flow.version,
				name: flow.name,
				description: flow.description || '',
				profileId: flow.profile_id,
				nodes,
				edges,
				metadata: {
					createdAt: flow.graph_definition?.metadata.createdAt || new Date().toISOString(),
					updatedAt: new Date().toISOString()
				}
			};

			await adminFlowsAPI.update(flow.id, {
				graph_definition: graphDefinition
			});

			hasChanges = false;
		} catch (err) {
			saveError = err instanceof Error ? err.message : 'Failed to save flow';
		} finally {
			saving = false;
		}
	}

	async function handleValidate() {
		if (!flow) return;

		try {
			const graphDefinition: GraphDefinition = {
				id: flow.id,
				flowVersion: flow.version,
				name: flow.name,
				description: flow.description || '',
				profileId: flow.profile_id,
				nodes,
				edges,
				metadata: {
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				}
			};

			const result = await adminFlowsAPI.validate(flow.id, graphDefinition);

			if (result.valid) {
				alert('Flow is valid!');
			} else {
				alert('Validation errors:\n' + result.errors.join('\n'));
			}
		} catch (err) {
			alert('Validation failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
		}
	}

	function handleBack() {
		if (hasChanges) {
			if (!confirm('You have unsaved changes. Are you sure you want to leave?')) {
				return;
			}
		}
		goto(`/admin/flows/${flowId}`);
	}
</script>

<div class="flow-edit-page">
	{#if loading}
		<div class="loading">Loading flow...</div>
	{:else if error && !flow}
		<div class="error-state">
			<p>{error}</p>
			<button class="btn-primary" onclick={loadFlow}>Retry</button>
			<button class="btn-secondary" onclick={() => goto('/admin/flows')}>Back to Flows</button>
		</div>
	{:else if flow}
		<div class="page-header">
			<div class="header-left">
				<button class="btn-back" onclick={handleBack}>← Back</button>
				<div class="flow-info">
					<h1>Edit: {flow.name}</h1>
					{#if hasChanges}
						<span class="unsaved-badge">Unsaved changes</span>
					{/if}
				</div>
			</div>
			<div class="header-actions">
				<button class="btn-secondary" onclick={handleValidate}> Validate </button>
				<button
					class="btn-primary"
					onclick={handleSave}
					disabled={saving || !hasChanges || !canEditFlow(flow)}
				>
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>

		{#if saveError}
			<div class="error-banner">
				<span>{saveError}</span>
				<button onclick={() => (saveError = '')}>Dismiss</button>
			</div>
		{/if}

		{#if !canEditFlow(flow)}
			<div class="warning-banner">
				<span>This flow is read-only because it is a builtin system flow.</span>
			</div>
		{/if}

		<div class="designer-layout">
			<div class="left-panel">
				<NodePalette onAddNode={handleAddNode} />
			</div>

			<div class="canvas-container">
				<FlowCanvas
					{nodes}
					{edges}
					readonly={!canEditFlow(flow)}
					onNodesChange={handleNodesChange}
					onEdgesChange={handleEdgesChange}
					onAddNode={handleAddNode}
					onNodeConfig={handleNodeConfig}
				/>
			</div>
		</div>

		<NodeConfigModal
			node={configModalNode}
			onSave={handleConfigSave}
			onClose={handleCloseConfigModal}
			onDelete={handleDeleteNode}
		/>
	{/if}
</div>

<style>
	.flow-edit-page {
		height: calc(100vh - 140px);
		display: flex;
		flex-direction: column;
	}

	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: #6b7280;
	}

	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 16px;
	}

	.error-state p {
		color: #b91c1c;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 16px 24px;
		background: white;
		border-bottom: 1px solid #e5e7eb;
		flex-shrink: 0;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.btn-back {
		padding: 6px 12px;
		background: transparent;
		border: none;
		color: #6b7280;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-back:hover {
		color: #111827;
	}

	.flow-info {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.flow-info h1 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
	}

	.unsaved-badge {
		padding: 4px 8px;
		background: #fef3c7;
		color: #92400e;
		font-size: 12px;
		border-radius: 4px;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.btn-primary {
		padding: 8px 16px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-primary:hover {
		background-color: #1d4ed8;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		padding: 8px 16px;
		background-color: white;
		color: #374151;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.error-banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 24px;
		background: #fef2f2;
		color: #b91c1c;
		border-bottom: 1px solid #fecaca;
		flex-shrink: 0;
	}

	.error-banner button {
		padding: 4px 8px;
		background: transparent;
		border: 1px solid #fecaca;
		border-radius: 4px;
		color: #b91c1c;
		font-size: 12px;
		cursor: pointer;
	}

	.warning-banner {
		padding: 12px 24px;
		background: #fef3c7;
		color: #92400e;
		border-bottom: 1px solid #fcd34d;
		font-size: 14px;
		flex-shrink: 0;
	}

	.designer-layout {
		display: flex;
		flex: 1;
		min-height: 0;
		padding: 16px;
		gap: 16px;
		background: #f3f4f6;
	}

	.left-panel {
		flex-shrink: 0;
	}

	.canvas-container {
		flex: 1;
		min-width: 0;
		border-radius: 8px;
		overflow: hidden;
	}
</style>
