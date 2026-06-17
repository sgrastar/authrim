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
	import { LL } from '$i18n/i18n-svelte';

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

	const sourceIcons: Record<SettingSource, string> = {
		env: 'i-ph-wrench',
		kv: 'i-ph-database',
		default: 'i-ph-clipboard-text'
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
		if (!scope) return $LL.admin_inheritance_parent();
		const labels: Record<SettingScopeLevel, string> = {
			platform: $LL.admin_settings_scope_platform(),
			tenant: $LL.admin_settings_scope_tenant(),
			client: $LL.admin_settings_scope_client()
		};
		return labels[scope];
	}

	function getSourceLabel(settingSource: SettingSource): string {
		const labels: Record<SettingSource, string> = {
			env: $LL.admin_inheritance_source_environment(),
			kv: $LL.admin_inheritance_source_kv(),
			default: $LL.admin_inheritance_source_default()
		};
		return labels[settingSource];
	}

	function getCompactTitle(): string {
		if (isOverridden) {
			return $LL.admin_inheritance_title_overridden({
				scope: getParentLabel(parentScope),
				value: formatValue(parentValue)
			});
		}
		if (isInherited) {
			return $LL.admin_inheritance_title_inherited({ scope: getParentLabel(parentScope) });
		}
		return $LL.admin_inheritance_title_source({ source: getSourceLabel(source) });
	}

	// Check if value is inherited (not locally set)
	let isInherited = $derived(!isOverridden && parentScope && parentScope !== currentScope);
</script>

{#if compact}
	<!-- Compact Mode: Single line badge -->
	<span
		class="indicator-compact"
		class:inherited={isInherited}
		class:overridden={isOverridden}
		class:readonly={source === 'env' || !canEdit}
		title={getCompactTitle()}
	>
		{#if source === 'env'}
			<span class="source-badge env">env</span>
			<i class="lock-icon i-ph-lock-key" aria-hidden="true"></i>
		{:else if isInherited}
			<i class="inherit-icon i-ph-arrow-up" aria-hidden="true"></i>
			<span class="inherit-text">{getParentLabel(parentScope)}</span>
		{:else if isOverridden}
			<i class="override-icon i-ph-check" aria-hidden="true"></i>
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
					<i class="badge-icon {sourceIcons[source]}" aria-hidden="true"></i>
					<span class="badge-text">{$LL.admin_inheritance_locked_by_environment()}</span>
					<i class="lock-icon i-ph-lock-key" aria-hidden="true"></i>
				</span>
			{:else if isInherited}
				<span class="indicator-badge inherited">
					<i class="badge-icon i-ph-arrow-up" aria-hidden="true"></i>
					<span class="badge-text">
						{$LL.admin_inheritance_inherited_from({ scope: getParentLabel(parentScope) })}
					</span>
				</span>
			{:else if isOverridden}
				<span class="indicator-badge overridden">
					<i class="badge-icon i-ph-check" aria-hidden="true"></i>
					<span class="badge-text">{$LL.admin_inheritance_override()}</span>
					<span class="source-tag">[kv]</span>
				</span>
			{:else}
				<span class="indicator-badge source-{source}">
					<i class="badge-icon {sourceIcons[source]}" aria-hidden="true"></i>
					<span class="badge-text">{getSourceLabel(source)}</span>
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.indicator-compact.inherited {
		border-color: color-mix(in srgb, var(--color-info) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-info) 12%, var(--color-surface));
		color: var(--color-info);
	}

	.indicator-compact.overridden {
		border-color: color-mix(in srgb, var(--color-success) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
	}

	.indicator-compact.readonly {
		border-color: color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface));
		color: var(--color-warning);
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
		border-radius: var(--radius-control, 4px);
	}

	.source-badge.env {
		background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface));
		color: var(--color-danger);
	}

	.source-badge.kv {
		background: color-mix(in srgb, var(--color-info) 14%, var(--color-surface));
		color: var(--color-info);
	}

	.source-badge.default {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 6px);
		font-size: 12px;
		font-weight: var(--font-weight-semibold, 600);
	}

	.indicator-badge.env {
		border-color: color-mix(in srgb, var(--color-warning) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 12%, var(--color-surface));
		color: var(--color-warning);
	}

	.indicator-badge.inherited {
		border-color: color-mix(in srgb, var(--color-info) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-info) 12%, var(--color-surface));
		color: var(--color-info);
	}

	.indicator-badge.overridden {
		border-color: color-mix(in srgb, var(--color-success) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
	}

	.indicator-badge.source-default {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.indicator-badge.source-kv {
		border-color: color-mix(in srgb, var(--color-info) 34%, var(--color-border));
		background: color-mix(in srgb, var(--color-info) 12%, var(--color-surface));
		color: var(--color-info);
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
		color: var(--color-text-muted);
		padding-left: 20px;
	}

	.parent-label {
		font-weight: 500;
	}

	.parent-value-text {
		font-family: var(--font-mono, monospace);
		background: var(--color-surface-muted);
		color: var(--color-text);
		padding: 2px 6px;
		border-radius: var(--radius-control, 4px);
	}
</style>
