<script lang="ts">
	import type { GraphNode, GraphNodeType } from '$lib/api/admin-flows';
	import { getFlowNodeColor } from './flow-node-metadata';

	interface Props {
		selectedNode: GraphNode | null;
		onUpdateNode: (nodeId: string, updates: Partial<GraphNode['data']>) => void;
		onDeleteNode: (nodeId: string) => void;
	}

	let { selectedNode, onUpdateNode, onDeleteNode }: Props = $props();

	let label = $state('');
	let configJson = $state('{}');
	let configError = $state('');

	// Sync with selected node
	$effect(() => {
		if (selectedNode) {
			label = selectedNode.data.label || '';
			configJson = JSON.stringify(selectedNode.data.config || {}, null, 2);
			configError = '';
		}
	});

	function handleLabelChange() {
		if (selectedNode) {
			onUpdateNode(selectedNode.id, { label });
		}
	}

	function handleConfigChange() {
		if (!selectedNode) return;

		try {
			const config = JSON.parse(configJson);
			configError = '';
			onUpdateNode(selectedNode.id, { config });
		} catch {
			configError = 'Invalid JSON';
		}
	}

	function handleDelete() {
		if (selectedNode && canDelete(selectedNode.type)) {
			onDeleteNode(selectedNode.id);
		}
	}

	function canDelete(type: GraphNodeType): boolean {
		// Start nodes cannot be deleted
		return type !== 'start';
	}

	function getNodeTypeLabel(type: GraphNodeType): string {
		const labels: Partial<Record<GraphNodeType, string>> = {
			// 1. Control Nodes
			start: 'Start Node',
			end: 'End Node',
			goto: 'Goto Node',
			// 2. Check Nodes
			check_session: 'Condition',
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
			login: 'Login Process',
			mfa: 'Multi-Factor Auth',
			register: 'Registration',
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
			error: 'Error Node',
			log: 'Log',
			// Legacy (deprecated)
			auth_method: 'Authentication',
			user_input: 'User Input Fields',
			wait_input: 'Wait Input',
			condition: 'Condition',
			check_user: 'Check User',
			risk_check: 'Risk Check',
			set_variable: 'Set Variable',
			call_api: 'Call API',
			send_notification: 'Notification'
		};
		return labels[type] || type;
	}
</script>

<div class="properties-panel">
	{#if selectedNode}
		<div class="panel-header" style="--type-color: {getFlowNodeColor(selectedNode.type)}">
			<span class="type-badge">{getNodeTypeLabel(selectedNode.type)}</span>
			<span class="node-id">{selectedNode.id}</span>
		</div>

		<div class="panel-content">
			<div class="form-group">
				<label for="node-label">Label</label>
				<input
					type="text"
					id="node-label"
					bind:value={label}
					onchange={handleLabelChange}
					placeholder="Enter node label"
				/>
			</div>

			<div class="form-group">
				<label for="node-position">Position</label>
				<div class="position-display">
					<span>X: {Math.round(selectedNode.position.x)}</span>
					<span>Y: {Math.round(selectedNode.position.y)}</span>
				</div>
			</div>

			<div class="form-group">
				<label for="node-config">
					Configuration
					<span class="hint">(JSON)</span>
				</label>
				<textarea
					id="node-config"
					bind:value={configJson}
					onchange={handleConfigChange}
					rows="6"
					class:has-error={!!configError}
				></textarea>
				{#if configError}
					<span class="error-text">{configError}</span>
				{/if}
			</div>

			{#if selectedNode.type === 'identifier'}
				<div class="config-helpers">
					<h4>Quick Config</h4>
					<div class="helper-buttons">
						<button
							onclick={() => {
								configJson = '{"type": "email"}';
								handleConfigChange();
							}}
						>
							Email
						</button>
						<button
							onclick={() => {
								configJson = '{"type": "phone"}';
								handleConfigChange();
							}}
						>
							Phone
						</button>
						<button
							onclick={() => {
								configJson = '{"type": "username"}';
								handleConfigChange();
							}}
						>
							Username
						</button>
					</div>
				</div>
			{/if}

			{#if selectedNode.type === 'auth_method'}
				<div class="config-helpers">
					<h4>Quick Config</h4>
					<div class="helper-buttons">
						<button
							onclick={() => {
								configJson = '{"method": "password"}';
								handleConfigChange();
							}}
						>
							Password
						</button>
						<button
							onclick={() => {
								configJson = '{"method": "passkey"}';
								handleConfigChange();
							}}
						>
							Passkey
						</button>
						<button
							onclick={() => {
								configJson = '{"method": "social"}';
								handleConfigChange();
							}}
						>
							Social
						</button>
					</div>
				</div>
			{/if}

			{#if selectedNode.type === 'mfa'}
				<div class="config-helpers">
					<h4>Quick Config</h4>
					<div class="helper-buttons">
						<button
							onclick={() => {
								configJson = '{"factor": "totp"}';
								handleConfigChange();
							}}
						>
							TOTP
						</button>
						<button
							onclick={() => {
								configJson = '{"factor": "sms"}';
								handleConfigChange();
							}}
						>
							SMS
						</button>
						<button
							onclick={() => {
								configJson = '{"factor": "email"}';
								handleConfigChange();
							}}
						>
							Email
						</button>
					</div>
				</div>
			{/if}
		</div>

		{#if canDelete(selectedNode.type)}
			<div class="panel-footer">
				<button class="btn-delete" onclick={handleDelete}> Delete Node </button>
			</div>
		{/if}
	{:else}
		<div class="empty-state">
			<span class="empty-icon">👆</span>
			<p>Select a node to view and edit its properties</p>
		</div>
	{/if}
</div>

<style>
	.properties-panel {
		width: 280px;
		background: var(--flow-panel-bg, var(--color-surface));
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, 8px);
		color: var(--color-text);
		display: flex;
		flex-direction: column;
		max-height: 100%;
		overflow: hidden;
		box-shadow: var(--shadow-panel, none);
	}

	.panel-header {
		padding: 16px;
		border-bottom: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.type-badge {
		font-size: 13px;
		font-weight: 600;
		color: var(--type-color);
	}

	.node-id {
		font-size: 11px;
		color: var(--color-text-muted);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
	}

	.panel-content {
		padding: 16px;
		flex: 1;
		overflow-y: auto;
	}

	.form-group {
		margin-bottom: 16px;
	}

	.form-group:last-child {
		margin-bottom: 0;
	}

	.form-group label {
		display: block;
		font-size: 13px;
		font-weight: var(--form-label-weight, 500);
		color: var(--form-label-color, var(--color-text));
		margin-bottom: 6px;
	}

	.form-group label .hint {
		font-weight: 400;
		color: var(--color-text-muted);
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: var(--control-border, 1px solid var(--color-border));
		border-radius: var(--radius-control, 6px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--control-shadow, none);
		font-size: 14px;
		font-family: inherit;
	}

	.form-group input:focus,
	.form-group textarea:focus {
		outline: none;
		border-color: var(--control-focus-border, var(--color-accent));
		box-shadow: var(--control-focus-shadow, 0 0 0 2px var(--color-accent-muted));
	}

	.form-group textarea {
		resize: vertical;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
		font-size: 12px;
	}

	.form-group textarea.has-error {
		border-color: var(--color-danger);
	}

	.error-text {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: var(--color-danger);
	}

	.position-display {
		display: flex;
		gap: 16px;
		padding: 8px 12px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		font-size: 13px;
		color: var(--color-text-muted);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
	}

	.config-helpers {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.config-helpers h4 {
		margin: 0 0 8px 0;
		font-size: 12px;
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-text-muted);
	}

	.helper-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.helper-buttons button {
		padding: 4px 10px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		font-size: 12px;
		color: var(--color-text);
		cursor: pointer;
		transition:
			background 0.2s ease,
			border-color 0.2s ease,
			color 0.2s ease;
	}

	.helper-buttons button:hover {
		border-color: var(--color-border-strong);
		background: var(--color-surface);
	}

	.panel-footer {
		padding: 16px;
		border-top: 1px solid var(--color-border);
	}

	.btn-delete {
		width: 100%;
		padding: 8px 16px;
		background: var(--color-surface);
		border: 1px solid color-mix(in srgb, var(--color-danger) 34%, var(--color-border));
		border-radius: var(--radius-control, 6px);
		color: var(--color-danger);
		font-size: 13px;
		cursor: pointer;
		transition:
			background 0.2s ease,
			border-color 0.2s ease;
	}

	.btn-delete:hover {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: var(--color-text-muted);
	}

	.empty-icon {
		font-size: 32px;
		display: block;
		margin-bottom: 8px;
	}

	.empty-state p {
		margin: 0;
		font-size: 13px;
	}
</style>
