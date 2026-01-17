<script lang="ts">
	import type { GraphNode, GraphNodeType } from '$lib/api/admin-flows';

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
			login_method_select: 'Login Method Select',
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

	function getNodeTypeColor(type: GraphNodeType): string {
		const colors: Partial<Record<GraphNodeType, string>> = {
			// 1. Control Nodes
			start: '#22c55e',
			end: '#10b981',
			goto: '#64748b',
			// 2. Check Nodes
			check_session: '#a855f7',
			check_auth_level: '#8b5cf6',
			check_first_login: '#7c3aed',
			check_user_attribute: '#6366f1',
			check_context: '#4f46e5',
			check_risk: '#dc2626',
			// 3. Selection Nodes
			auth_method_select: '#3b82f6',
			login_method_select: '#0ea5e9',
			identifier: '#06b6d4',
			profile_input: '#0891b2',
			custom_form: '#0284c7',
			information: '#64748b',
			challenge: '#f59e0b',
			// 4. Authentication Nodes
			login: '#6366f1',
			mfa: '#f59e0b',
			register: '#10b981',
			// 5. Consent Nodes
			consent: '#06b6d4',
			check_consent_status: '#0891b2',
			record_consent: '#0284c7',
			// 6. Resolve Nodes
			resolve_tenant: '#8b5cf6',
			resolve_org: '#7c3aed',
			resolve_policy: '#6366f1',
			// 7. Session Nodes
			issue_tokens: '#22c55e',
			refresh_session: '#10b981',
			revoke_session: '#ef4444',
			bind_device: '#f59e0b',
			link_account: '#ec4899',
			// 8. Side Effect Nodes
			redirect: '#0891b2',
			webhook: '#0284c7',
			event_emit: '#059669',
			email_send: '#7c3aed',
			sms_send: '#8b5cf6',
			push_notify: '#a855f7',
			// 9. Logic Nodes
			decision: '#ec4899',
			switch: '#f43f5e',
			// 10. Policy Nodes
			policy_check: '#4f46e5',
			// 11. Error Nodes
			error: '#ef4444',
			log: '#64748b',
			// Legacy (deprecated)
			auth_method: '#8b5cf6',
			user_input: '#0ea5e9',
			wait_input: '#64748b',
			condition: '#ec4899',
			check_user: '#7c3aed',
			risk_check: '#dc2626',
			set_variable: '#059669',
			call_api: '#0284c7',
			send_notification: '#7c3aed'
		};
		return colors[type] || '#6b7280';
	}
</script>

<div class="properties-panel">
	{#if selectedNode}
		<div class="panel-header" style="--type-color: {getNodeTypeColor(selectedNode.type)}">
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
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		max-height: 100%;
		overflow: hidden;
	}

	.panel-header {
		padding: 16px;
		border-bottom: 1px solid #e5e7eb;
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
		color: #9ca3af;
		font-family: ui-monospace, SFMono-Regular, monospace;
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
		font-weight: 500;
		color: #374151;
		margin-bottom: 6px;
	}

	.form-group label .hint {
		font-weight: 400;
		color: #9ca3af;
	}

	.form-group input,
	.form-group textarea {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		font-family: inherit;
	}

	.form-group input:focus,
	.form-group textarea:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
	}

	.form-group textarea {
		resize: vertical;
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 12px;
	}

	.form-group textarea.has-error {
		border-color: #ef4444;
	}

	.error-text {
		display: block;
		margin-top: 4px;
		font-size: 12px;
		color: #ef4444;
	}

	.position-display {
		display: flex;
		gap: 16px;
		padding: 8px 12px;
		background: #f9fafb;
		border-radius: 6px;
		font-size: 13px;
		color: #6b7280;
		font-family: ui-monospace, SFMono-Regular, monospace;
	}

	.config-helpers {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid #e5e7eb;
	}

	.config-helpers h4 {
		margin: 0 0 8px 0;
		font-size: 12px;
		font-weight: 500;
		color: #6b7280;
	}

	.helper-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.helper-buttons button {
		padding: 4px 10px;
		background: #f3f4f6;
		border: 1px solid #e5e7eb;
		border-radius: 4px;
		font-size: 12px;
		color: #374151;
		cursor: pointer;
		transition: all 0.2s;
	}

	.helper-buttons button:hover {
		background: #e5e7eb;
	}

	.panel-footer {
		padding: 16px;
		border-top: 1px solid #e5e7eb;
	}

	.btn-delete {
		width: 100%;
		padding: 8px 16px;
		background: white;
		border: 1px solid #fecaca;
		border-radius: 6px;
		color: #dc2626;
		font-size: 13px;
		cursor: pointer;
		transition: all 0.2s;
	}

	.btn-delete:hover {
		background: #fef2f2;
	}

	.empty-state {
		padding: 32px 16px;
		text-align: center;
		color: #9ca3af;
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
