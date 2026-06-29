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
	import { isLegacyPreviewFlowId } from '$lib/api/legacy-flow-preview';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import { FlowCanvas, NodePalette, NodeConfigModal } from '$lib/components/flow-designer';
	import { getFlowNodeMetadata } from '$lib/components/flow-designer/flow-node-metadata';

	// Product note: Flow may be omitted from Admin UI; keep new i18n work for this
	// feature paused until product direction is confirmed.

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
	const flowIsPreview = $derived.by(() => (flow ? isLegacyPreviewFlowId(flow.id) : false));
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
		const metadata = getFlowNodeMetadata(type);
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
			login_method_select: 'Authentication Method Select',
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

<svelte:head>
	<title>{flow ? `Edit ${flow.name} - Flows - Authrim` : 'Edit Flow - Authrim'}</title>
</svelte:head>

<AdminPageShell>
	<div class="flow-edit-page">
		{#if loading}
			<div class="loading-state">Loading flow...</div>
		{:else if error && !flow}
			<div class="flow-error-state">
				<p>{error}</p>
				<button type="button" class="btn btn-primary" onclick={loadFlow}>Retry</button>
				<button type="button" class="btn btn-secondary" onclick={() => goto('/admin/flows')}
					>Back to Flows</button
				>
			</div>
		{:else if flow}
			<div class="flow-edit-header">
				<div class="flow-edit-header-left">
					<button type="button" class="btn btn-ghost" onclick={handleBack}>
						<i class="i-ph-arrow-left" aria-hidden="true"></i>
						<span>Back</span>
					</button>
					<div class="flow-edit-header-info">
						<h1>Edit: {flow.name}</h1>
						{#if flowIsPreview}
							<span class="preview-badge">Preview only</span>
						{/if}
						{#if hasChanges}
							<span class="unsaved-badge">Unsaved changes</span>
						{/if}
					</div>
				</div>
				<div class="flow-edit-header-actions">
					<button type="button" class="btn btn-secondary" onclick={handleValidate}>Validate</button>
					<button
						type="button"
						class="btn btn-primary"
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
					<button type="button" onclick={() => (saveError = '')}>Dismiss</button>
				</div>
			{/if}

			{#if flowIsPreview}
				<div class="warning-banner">
					<span>
						This is a legacy preview flow. You can inspect and experiment with the old designer, but
						changes are not connected to runtime execution.
					</span>
				</div>
			{/if}

			{#if !canEditFlow(flow)}
				<div class="warning-banner">
					<span>This flow is read-only because it is a builtin system flow.</span>
				</div>
			{/if}

			<div class="designer-layout">
				<div class="designer-left-panel">
					<NodePalette onAddNode={handleAddNode} />
				</div>

				<div class="designer-canvas-container">
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
</AdminPageShell>

<style>
	.flow-edit-page {
		min-height: calc(100vh - var(--header-height, 64px));
		display: flex;
		flex-direction: column;
		background: var(--color-page-bg, var(--color-surface-muted));
		color: var(--color-text);
	}

	.loading-state,
	.flow-error-state {
		min-height: 420px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
	}

	.flow-error-state {
		flex-direction: column;
		gap: 16px;
		text-align: center;
	}

	.flow-error-state p {
		margin: 0;
		color: var(--color-danger);
	}

	.flow-edit-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		flex-shrink: 0;
		padding: 14px 20px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
		box-shadow: var(--flow-editor-header-shadow, var(--card-shadow, none));
	}

	.flow-edit-header-left,
	.flow-edit-header-info,
	.flow-edit-header-actions {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.flow-edit-header-info {
		flex-wrap: wrap;
	}

	.flow-edit-header-info h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		line-height: 1.25;
		color: var(--color-text);
	}

	.flow-edit-header-actions {
		justify-content: flex-end;
	}

	.btn {
		min-height: var(--control-height, 36px);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 0 13px;
		border: 1px solid var(--color-border);
		border-radius: var(--toolbar-control-radius, var(--radius-control, 8px));
		font: inherit;
		font-weight: 800;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 120ms ease,
			border-color 120ms ease,
			color 120ms ease,
			transform 120ms ease;
	}

	.btn:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.btn-primary {
		border-color: var(--button-primary-bg, var(--color-accent));
		background: var(--button-primary-bg, var(--color-accent));
		color: var(--button-primary-color, var(--color-accent-contrast));
	}

	.btn-secondary,
	.btn-ghost {
		background: var(--color-surface);
		color: var(--color-text);
	}

	.btn-secondary:hover:not(:disabled),
	.btn-ghost:hover:not(:disabled) {
		border-color: var(--color-accent);
		background: var(--color-surface-muted);
		color: var(--color-accent);
	}

	.unsaved-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 9px;
		border-radius: var(--status-badge-radius, 999px);
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
		font-size: 0.75rem;
		font-weight: 800;
	}

	.preview-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 9px;
		border-radius: var(--status-badge-radius, 999px);
		background: color-mix(in srgb, var(--color-info, var(--color-accent)) 14%, transparent);
		color: var(--color-info, var(--color-accent));
		font-size: 0.75rem;
		font-weight: 800;
	}

	.error-banner,
	.warning-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-shrink: 0;
		padding: 12px 20px;
		border-bottom: 1px solid;
		font-size: 0.875rem;
	}

	.error-banner {
		border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
	}

	.warning-banner {
		border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface));
		color: var(--color-warning);
	}

	.error-banner button {
		min-height: 28px;
		padding: 0 9px;
		border: 1px solid currentColor;
		border-radius: var(--toolbar-control-radius, var(--radius-control, 8px));
		background: transparent;
		color: inherit;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 800;
		cursor: pointer;
	}

	.designer-layout {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 14px;
		padding: 14px;
		background: var(--color-page-bg, var(--color-surface-muted));
	}

	.designer-left-panel,
	.designer-canvas-container {
		min-height: 0;
	}

	.designer-left-panel {
		min-width: 0;
	}

	.designer-canvas-container {
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		background: var(--color-surface);
		overflow: hidden;
		box-shadow: var(--flow-editor-canvas-shadow, var(--card-shadow, none));
	}

	@media (max-width: 900px) {
		.flow-edit-header,
		.flow-edit-header-left,
		.flow-edit-header-actions,
		.designer-layout {
			display: grid;
			grid-template-columns: 1fr;
		}

		.flow-edit-header-actions {
			justify-content: stretch;
		}

		.flow-edit-header-actions .btn {
			width: 100%;
		}
	}
</style>
