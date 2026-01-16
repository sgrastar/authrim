<script lang="ts">
	/**
	 * Inheritance Indicator Component
	 *
	 * Shows the inheritance status of a setting value:
	 * - Whether the value is inherited from a parent scope
	 * - The source of the value (env, kv, default)
	 * - The parent value if overridden
	 */

	import type { SettingSource } from '$lib/api/admin-settings';
	import type { SettingScopeLevel } from '$lib/stores/settings-context.svelte';

	interface Props {
		/** Current value source */
		source: SettingSource;
		/** Current scope level */
		currentScope: SettingScopeLevel;
		/** Parent scope value (if different from current) */
		parentValue?: unknown;
		/** Parent scope level */
		parentScope?: SettingScopeLevel;
		/** Whether the value is overridden from parent */
		isOverridden?: boolean;
		/** Whether editing is allowed */
		canEdit?: boolean;
		/** Compact mode for inline display */
		compact?: boolean;
	}

	let {
		source,
		currentScope,
		parentValue,
		parentScope,
		isOverridden = false,
		canEdit = true,
		compact = false
	}: Props = $props();

	// Source display configuration
	const sourceConfig: Record<SettingSource, { label: string; icon: string; color: string }> = {
		env: { label: 'Environment', icon: '🔧', color: '#dc2626' },
		kv: { label: 'KV Store', icon: '💾', color: '#3b82f6' },
		default: { label: 'Default', icon: '📋', color: '#6b7280' }
	};


	// Format value for display
	function formatValue(value: unknown): string {
		if (value === null || value === undefined) return 'null';
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		if (typeof value === 'number') return value.toString();
		if (typeof value === 'string') {
			if (value.length > 30) return `"${value.substring(0, 27)}..."`;
			return `"${value}"`;
		}
		return JSON.stringify(value);
	}

	// Get parent scope label
	function getParentLabel(scope?: SettingScopeLevel): string {
		if (!scope) return 'Parent';
		const labels: Record<SettingScopeLevel, string> = {
			platform: 'Platform',
			tenant: 'Tenant',
			client: 'Client'
		};
		return labels[scope];
	}

	// Check if value is inherited (not locally set)
	let isInherited = $derived(!isOverridden && parentScope && parentScope !== currentScope);

	// Source info
	let sourceInfo = $derived(sourceConfig[source]);
</script>

{#if compact}
	<!-- Compact Mode: Single line badge -->
	<span
		class="indicator-compact"
		class:inherited={isInherited}
		class:overridden={isOverridden}
		class:readonly={source === 'env' || !canEdit}
		title={isOverridden
			? `Overridden (${getParentLabel(parentScope)}: ${formatValue(parentValue)})`
			: isInherited
				? `Inherited from ${getParentLabel(parentScope)}`
				: `Source: ${sourceInfo.label}`}
	>
		{#if source === 'env'}
			<span class="source-badge env">env</span>
			<span class="lock-icon">🔒</span>
		{:else if isInherited}
			<span class="inherit-icon">↑</span>
			<span class="inherit-text">{getParentLabel(parentScope)}</span>
		{:else if isOverridden}
			<span class="override-icon">✓</span>
			<span class="source-badge kv">kv</span>
		{:else}
			<span class="source-badge {source}">{source}</span>
		{/if}
	</span>
{:else}
	<!-- Full Mode: Detailed display -->
	<div
		class="indicator-full"
		class:inherited={isInherited}
		class:overridden={isOverridden}
		class:readonly={source === 'env' || !canEdit}
	>
		<!-- Primary indicator -->
		<div class="primary-row">
			{#if source === 'env'}
				<span class="indicator-badge env">
					<span class="badge-icon">{sourceInfo.icon}</span>
					<span class="badge-text">Locked by Environment</span>
					<span class="lock-icon">🔒</span>
				</span>
			{:else if isInherited}
				<span class="indicator-badge inherited">
					<span class="badge-icon">↑</span>
					<span class="badge-text">Inherited from {getParentLabel(parentScope)}</span>
				</span>
			{:else if isOverridden}
				<span class="indicator-badge overridden">
					<span class="badge-icon">✓</span>
					<span class="badge-text">Override</span>
					<span class="source-tag">[kv]</span>
				</span>
			{:else}
				<span class="indicator-badge source-{source}">
					<span class="badge-icon">{sourceInfo.icon}</span>
					<span class="badge-text">{sourceInfo.label}</span>
				</span>
			{/if}
		</div>

		<!-- Parent value (when overridden) -->
		{#if isOverridden && parentValue !== undefined}
			<div class="parent-value">
				<span class="parent-label">{getParentLabel(parentScope)}:</span>
				<span class="parent-value-text">{formatValue(parentValue)}</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	/* Compact Mode Styles */
	.indicator-compact {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 4px;
		background-color: #f3f4f6;
		color: #6b7280;
	}

	.indicator-compact.inherited {
		background-color: #e0f2fe;
		color: #0369a1;
	}

	.indicator-compact.overridden {
		background-color: #d1fae5;
		color: #065f46;
	}

	.indicator-compact.readonly {
		background-color: #fef3c7;
		color: #92400e;
	}

	.inherit-icon,
	.override-icon {
		font-size: 12px;
	}

	.inherit-text {
		font-weight: 500;
	}

	.source-badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		padding: 1px 4px;
		border-radius: 3px;
	}

	.source-badge.env {
		background-color: #fecaca;
		color: #b91c1c;
	}

	.source-badge.kv {
		background-color: #bfdbfe;
		color: #1d4ed8;
	}

	.source-badge.default {
		background-color: #e5e7eb;
		color: #4b5563;
	}

	.lock-icon {
		font-size: 10px;
	}

	/* Full Mode Styles */
	.indicator-full {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.primary-row {
		display: flex;
		align-items: center;
	}

	.indicator-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: 6px;
		font-size: 12px;
		font-weight: 500;
	}

	.indicator-badge.env {
		background-color: #fef3c7;
		color: #92400e;
	}

	.indicator-badge.inherited {
		background-color: #e0f2fe;
		color: #0369a1;
	}

	.indicator-badge.overridden {
		background-color: #d1fae5;
		color: #065f46;
	}

	.indicator-badge.source-default {
		background-color: #f3f4f6;
		color: #6b7280;
	}

	.indicator-badge.source-kv {
		background-color: #dbeafe;
		color: #1d4ed8;
	}

	.badge-icon {
		font-size: 14px;
	}

	.badge-text {
		white-space: nowrap;
	}

	.source-tag {
		font-size: 10px;
		opacity: 0.7;
		font-weight: 600;
	}

	.parent-value {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		color: #6b7280;
		padding-left: 20px;
	}

	.parent-label {
		font-weight: 500;
	}

	.parent-value-text {
		font-family: monospace;
		background-color: #f9fafb;
		padding: 2px 6px;
		border-radius: 3px;
	}

	/* Dark mode */
	@media (prefers-color-scheme: dark) {
		.indicator-compact {
			background-color: #374151;
			color: #9ca3af;
		}

		.indicator-compact.inherited {
			background-color: rgba(14, 165, 233, 0.2);
			color: #7dd3fc;
		}

		.indicator-compact.overridden {
			background-color: rgba(16, 185, 129, 0.2);
			color: #6ee7b7;
		}

		.indicator-compact.readonly {
			background-color: rgba(251, 191, 36, 0.2);
			color: #fcd34d;
		}

		.source-badge.env {
			background-color: rgba(220, 38, 38, 0.3);
			color: #fca5a5;
		}

		.source-badge.kv {
			background-color: rgba(59, 130, 246, 0.3);
			color: #93c5fd;
		}

		.source-badge.default {
			background-color: rgba(107, 114, 128, 0.3);
			color: #d1d5db;
		}

		.indicator-badge.env {
			background-color: rgba(251, 191, 36, 0.2);
			color: #fcd34d;
		}

		.indicator-badge.inherited {
			background-color: rgba(14, 165, 233, 0.2);
			color: #7dd3fc;
		}

		.indicator-badge.overridden {
			background-color: rgba(16, 185, 129, 0.2);
			color: #6ee7b7;
		}

		.indicator-badge.source-default {
			background-color: #374151;
			color: #9ca3af;
		}

		.indicator-badge.source-kv {
			background-color: rgba(59, 130, 246, 0.2);
			color: #93c5fd;
		}

		.parent-value {
			color: #9ca3af;
		}

		.parent-value-text {
			background-color: #374151;
		}
	}
</style>
