<script lang="ts">
	import type { GraphNodeType, NodeCategory } from '$lib/api/admin-flows';

	interface NodeTypeInfo {
		type: GraphNodeType;
		label: string;
		icon: string;
		color: string;
		description: string;
		category: NodeCategory;
		options?: string[]; // Available options for this node type
	}

	interface Props {
		onAddNode: (type: GraphNodeType, position: { x: number; y: number }) => void;
	}

	let { onAddNode }: Props = $props();

	// Hover state for tooltip
	let hoveredNode: NodeTypeInfo | null = $state(null);
	let tooltipPosition = $state({ x: 0, y: 0 });

	// V1 Node Types - organized by 11 categories
	const nodeTypes: NodeTypeInfo[] = [
		// === 1. Control Nodes (制御系) ===
		{
			type: 'start',
			label: 'Start',
			icon: '▶',
			color: '#22c55e',
			description: 'Flow entry point',
			category: 'control'
		},
		{
			type: 'end',
			label: 'End',
			icon: '●',
			color: '#10b981',
			description: 'Flow success exit',
			category: 'control'
		},
		{
			type: 'goto',
			label: 'Goto',
			icon: '↪',
			color: '#64748b',
			description: 'Jump to another node',
			category: 'control'
		},

		// === 2. State/Check Nodes (状態判定系) ===
		{
			type: 'check_session',
			label: 'Condition',
			icon: '🔍',
			color: '#a855f7',
			description: 'Check session/user/context state (fact-based)',
			category: 'check',
			options: ['Is Logged In?', 'MFA Verified?', 'Email Verified?', 'First Login?', 'New Device?']
		},
		{
			type: 'check_auth_level',
			label: 'Auth Level',
			icon: '📊',
			color: '#8b5cf6',
			description: 'Check authentication level',
			category: 'check',
			options: ['basic', 'mfa', 'step_up']
		},
		{
			type: 'check_first_login',
			label: 'First Login',
			icon: '🆕',
			color: '#7c3aed',
			description: 'Is this first login?',
			category: 'check'
		},
		{
			type: 'check_user_attribute',
			label: 'User Attr',
			icon: '👁️',
			color: '#6366f1',
			description: 'Check user attributes',
			category: 'check',
			options: ['email_verified', 'phone_verified', 'mfa_enabled', 'has_password', 'has_passkey']
		},
		{
			type: 'check_context',
			label: 'Context',
			icon: '📍',
			color: '#4f46e5',
			description: 'Check request context',
			category: 'check',
			options: ['new_device', 'high_risk', 'suspicious_ip']
		},
		{
			type: 'check_risk',
			label: 'Risk',
			icon: '⚠️',
			color: '#dc2626',
			description: 'Evaluate risk score',
			category: 'check',
			options: ['low', 'medium', 'high']
		},

		// === 3. Selection/UI Nodes (選択・入力系) ===
		{
			type: 'auth_method_select',
			label: 'Auth Select',
			icon: '🔑',
			color: '#3b82f6',
			description: 'User selects auth method',
			category: 'selection',
			options: ['Password', 'Passkey', 'Email OTP', 'SMS OTP', 'Magic Link', 'Social']
		},
		{
			type: 'login_method_select',
			label: 'Login Select',
			icon: '🚪',
			color: '#0ea5e9',
			description: 'User selects login method',
			category: 'selection',
			options: ['Email + Password', 'Social Login', 'Passkey', 'Enterprise SSO']
		},
		{
			type: 'identifier',
			label: 'Identifier',
			icon: '👤',
			color: '#06b6d4',
			description: 'Collect user ID (email/phone)',
			category: 'selection',
			options: ['Email', 'Phone', 'Username']
		},
		{
			type: 'profile_input',
			label: 'Profile',
			icon: '📋',
			color: '#0891b2',
			description: 'Collect profile fields',
			category: 'selection',
			options: ['Name', 'Phone', 'Address', 'Birthdate']
		},
		{
			type: 'custom_form',
			label: 'Custom Form',
			icon: '📄',
			color: '#0284c7',
			description: 'Custom input form',
			category: 'selection'
		},
		{
			type: 'information',
			label: 'Information',
			icon: 'ℹ️',
			color: '#64748b',
			description: 'Display information screen',
			category: 'selection'
		},
		{
			type: 'challenge',
			label: 'Challenge',
			icon: '🎯',
			color: '#f59e0b',
			description: 'Security challenge (CAPTCHA)',
			category: 'selection',
			options: ['CAPTCHA', 'Security Question']
		},

		// === 4. Authentication Nodes (認証実行系) ===
		{
			type: 'login',
			label: 'Login',
			icon: '🔐',
			color: '#6366f1',
			description: 'Execute login with method',
			category: 'auth',
			options: ['Password', 'Passkey', 'Social', 'Magic Link']
		},
		{
			type: 'mfa',
			label: 'MFA',
			icon: '🛡️',
			color: '#f59e0b',
			description: 'Multi-factor authentication',
			category: 'auth',
			options: ['TOTP', 'SMS', 'Email OTP', 'WebAuthn']
		},
		{
			type: 'register',
			label: 'Register',
			icon: '📝',
			color: '#10b981',
			description: 'User registration',
			category: 'auth'
		},

		// === 5. Consent/Profile Nodes (同意・プロフィール) ===
		{
			type: 'consent',
			label: 'Consent',
			icon: '✓',
			color: '#06b6d4',
			description: 'Request user consent',
			category: 'consent',
			options: ['Terms', 'Privacy', 'Marketing', 'Data Processing']
		},
		{
			type: 'check_consent_status',
			label: 'Check Consent',
			icon: '✔️',
			color: '#0891b2',
			description: 'Check if consent given',
			category: 'consent'
		},
		{
			type: 'record_consent',
			label: 'Record Consent',
			icon: '📜',
			color: '#0284c7',
			description: 'Record consent decision',
			category: 'consent'
		},

		// === 6. Resolve Nodes (解決系) ===
		{
			type: 'resolve_tenant',
			label: 'Resolve Tenant',
			icon: '🏢',
			color: '#8b5cf6',
			description: 'Resolve tenant from email domain',
			category: 'resolve'
		},
		{
			type: 'resolve_org',
			label: 'Resolve Org',
			icon: '🏛️',
			color: '#7c3aed',
			description: 'Resolve organization',
			category: 'resolve'
		},
		{
			type: 'resolve_policy',
			label: 'Resolve Policy',
			icon: '📋',
			color: '#6366f1',
			description: 'Resolve applicable policies',
			category: 'resolve'
		},

		// === 7. Session/Token Nodes ===
		{
			type: 'issue_tokens',
			label: 'Issue Tokens',
			icon: '🎫',
			color: '#22c55e',
			description: 'Issue access/refresh tokens',
			category: 'session'
		},
		{
			type: 'refresh_session',
			label: 'Refresh',
			icon: '🔄',
			color: '#10b981',
			description: 'Refresh session',
			category: 'session'
		},
		{
			type: 'revoke_session',
			label: 'Revoke',
			icon: '🚫',
			color: '#ef4444',
			description: 'Revoke session',
			category: 'session'
		},
		{
			type: 'bind_device',
			label: 'Bind Device',
			icon: '📱',
			color: '#f59e0b',
			description: 'Bind device to session',
			category: 'session'
		},
		{
			type: 'link_account',
			label: 'Link Account',
			icon: '🔗',
			color: '#ec4899',
			description: 'Link social account',
			category: 'session'
		},

		// === 8. Side Effect Nodes ===
		{
			type: 'redirect',
			label: 'Redirect',
			icon: '↗️',
			color: '#0891b2',
			description: 'Redirect to semantic destination',
			category: 'side_effect'
		},
		{
			type: 'webhook',
			label: 'Webhook',
			icon: '🌐',
			color: '#0284c7',
			description: 'Call webhook',
			category: 'side_effect'
		},
		{
			type: 'event_emit',
			label: 'Emit Event',
			icon: '📡',
			color: '#059669',
			description: 'Emit custom event',
			category: 'side_effect'
		},
		{
			type: 'email_send',
			label: 'Email',
			icon: '📧',
			color: '#7c3aed',
			description: 'Send email',
			category: 'side_effect'
		},
		{
			type: 'sms_send',
			label: 'SMS',
			icon: '💬',
			color: '#8b5cf6',
			description: 'Send SMS',
			category: 'side_effect'
		},
		{
			type: 'push_notify',
			label: 'Push',
			icon: '🔔',
			color: '#a855f7',
			description: 'Send push notification',
			category: 'side_effect'
		},

		// === 9. Logic/Decision Nodes ===
		{
			type: 'decision',
			label: 'Decision',
			icon: '◇',
			color: '#8b5cf6',
			description: 'N-way conditional branch (3+ branches)',
			category: 'logic',
			options: ['Risk-based routing', 'Social login result', 'Multi-condition flow']
		},
		{
			type: 'switch',
			label: 'Switch',
			icon: '⎇',
			color: '#a855f7',
			description: 'Enum-based branching (country, locale, etc)',
			category: 'logic',
			options: ['Country-based', 'Locale-based', 'Client type routing']
		},

		// === 10. Policy Nodes ===
		{
			type: 'policy_check',
			label: 'Policy Check',
			icon: '🛡️',
			color: '#4f46e5',
			description: 'Evaluate policy rules',
			category: 'policy'
		},

		// === 11. Error/Debug Nodes ===
		{
			type: 'error',
			label: 'Error',
			icon: '✕',
			color: '#ef4444',
			description: 'Error screen with reason',
			category: 'error'
		},
		{
			type: 'log',
			label: 'Log',
			icon: '📋',
			color: '#64748b',
			description: 'Log for debugging',
			category: 'error'
		}
	];

	// Group nodes by 11 categories (v1 design)
	const categories: { id: NodeCategory; label: string; description: string }[] = [
		{ id: 'control', label: 'Control', description: 'Flow control' },
		{ id: 'check', label: 'Check', description: 'State checks' },
		{ id: 'selection', label: 'Selection', description: 'User input/selection' },
		{ id: 'auth', label: 'Auth', description: 'Authentication' },
		{ id: 'consent', label: 'Consent', description: 'User consent' },
		{ id: 'resolve', label: 'Resolve', description: 'Resolution logic' },
		{ id: 'session', label: 'Session', description: 'Session/tokens' },
		{ id: 'side_effect', label: 'Effects', description: 'Side effects' },
		{ id: 'logic', label: 'Logic', description: 'Decision nodes' },
		{ id: 'policy', label: 'Policy', description: 'Policy evaluation' },
		{ id: 'error', label: 'Error', description: 'Error handling' }
	];

	const nodesByCategory = $derived(
		categories.map((cat) => ({
			...cat,
			nodes: nodeTypes.filter((n) => n.category === cat.id)
		}))
	);

	let draggedType: GraphNodeType | null = $state(null);

	function handleDragStart(event: DragEvent, type: GraphNodeType) {
		draggedType = type;
		event.dataTransfer!.effectAllowed = 'copy';
		event.dataTransfer!.setData('application/flow-node', type);
	}

	function handleDragEnd() {
		draggedType = null;
	}

	function handleClick(type: GraphNodeType) {
		// Add node at a default position when clicked
		onAddNode(type, { x: 300, y: 200 });
	}

	function handleMouseEnter(event: MouseEvent, nodeType: NodeTypeInfo) {
		hoveredNode = nodeType;
		const rect = (event.target as HTMLElement).getBoundingClientRect();
		tooltipPosition = { x: rect.right + 8, y: rect.top };
	}

	function handleMouseLeave() {
		hoveredNode = null;
	}
</script>

<div class="node-palette">
	<h3 class="palette-title">Node Types</h3>
	<p class="palette-hint">Click to add to canvas</p>

	<div class="category-list">
		{#each nodesByCategory as category (category.id)}
			<div class="category-section">
				<div class="category-header">
					<span class="category-label">{category.label}</span>
					<span class="category-desc">{category.description}</span>
				</div>
				<div class="node-list">
					{#each category.nodes as nodeType (nodeType.type)}
						<button
							class="node-item"
							class:dragging={draggedType === nodeType.type}
							draggable="true"
							ondragstart={(e) => handleDragStart(e, nodeType.type)}
							ondragend={handleDragEnd}
							onclick={() => handleClick(nodeType.type)}
							onmouseenter={(e) => handleMouseEnter(e, nodeType)}
							onmouseleave={handleMouseLeave}
							style="--node-color: {nodeType.color}"
						>
							<span class="node-icon">{nodeType.icon}</span>
							<span class="node-label">{nodeType.label}</span>
						</button>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>

{#if hoveredNode}
	<div class="node-tooltip" style="left: {tooltipPosition.x}px; top: {tooltipPosition.y}px">
		<div class="tooltip-header" style="--node-color: {hoveredNode.color}">
			<span class="tooltip-icon">{hoveredNode.icon}</span>
			<span class="tooltip-label">{hoveredNode.label}</span>
		</div>
		<p class="tooltip-description">{hoveredNode.description}</p>
		{#if hoveredNode.options && hoveredNode.options.length > 0}
			<div class="tooltip-options">
				<span class="options-label">Options:</span>
				<ul class="options-list">
					{#each hoveredNode.options as option, i (i)}
						<li>{option}</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/if}

<style>
	.node-palette {
		width: 200px;
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 12px;
		height: fit-content;
		max-height: calc(100vh - 200px);
		overflow-y: auto;
	}

	.palette-title {
		margin: 0 0 4px 0;
		font-size: 14px;
		font-weight: 600;
		color: #111827;
	}

	.palette-hint {
		margin: 0 0 12px 0;
		font-size: 11px;
		color: #9ca3af;
	}

	.category-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.category-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.category-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 4px 0;
		border-bottom: 1px solid #e5e7eb;
	}

	.category-label {
		font-size: 11px;
		font-weight: 600;
		color: #6b7280;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.category-desc {
		font-size: 10px;
		color: #9ca3af;
	}

	.node-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.node-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		cursor: pointer;
		transition: all 0.15s;
		text-align: left;
		font-size: 12px;
	}

	.node-item:hover {
		border-color: var(--node-color);
		background: color-mix(in srgb, var(--node-color) 5%, white);
		transform: translateY(-1px);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
	}

	.node-item:active {
		transform: translateY(0);
	}

	.node-item.dragging {
		opacity: 0.5;
		transform: scale(0.95);
	}

	.node-icon {
		font-size: 14px;
		width: 22px;
		height: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--node-color) 15%, white);
		border-radius: 4px;
		flex-shrink: 0;
	}

	.node-label {
		font-size: 11px;
		font-weight: 500;
		color: #374151;
		white-space: nowrap;
	}

	/* Tooltip styles */
	.node-tooltip {
		position: fixed;
		z-index: 1000;
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		padding: 12px;
		min-width: 200px;
		max-width: 280px;
		pointer-events: none;
	}

	.tooltip-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		padding-bottom: 8px;
		border-bottom: 1px solid #f3f4f6;
	}

	.tooltip-icon {
		font-size: 16px;
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--node-color) 15%, white);
		border-radius: 6px;
	}

	.tooltip-label {
		font-size: 14px;
		font-weight: 600;
		color: #111827;
	}

	.tooltip-description {
		margin: 0 0 8px 0;
		font-size: 12px;
		color: #6b7280;
		line-height: 1.4;
	}

	.tooltip-options {
		background: #f9fafb;
		border-radius: 6px;
		padding: 8px;
	}

	.options-label {
		font-size: 10px;
		font-weight: 600;
		color: #9ca3af;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.options-list {
		margin: 4px 0 0 0;
		padding: 0 0 0 16px;
		font-size: 11px;
		color: #4b5563;
	}

	.options-list li {
		margin: 2px 0;
	}
</style>
