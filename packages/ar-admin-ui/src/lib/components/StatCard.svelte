<script lang="ts">
	interface Props {
		value: string | number;
		label: string;
		icon?: string;
		iconColor?: 'purple' | 'green' | 'pink' | 'orange';
		change?: {
			value: string | number;
			positive: boolean;
		};
		level?: 'system' | 'tenant' | 'client';
	}

	let { value, label, icon, iconColor = 'purple', change, level }: Props = $props();
</script>

<div class="stat-card" data-level={level}>
	<div class="stat-header">
		{#if icon}
			<div class="stat-icon {iconColor}">
				<i class={icon}></i>
			</div>
		{/if}
		{#if change}
			<span class="stat-change" class:positive={change.positive} class:negative={!change.positive}>
				{#if change.positive}
					<i class="i-ph-trending-up"></i>
				{:else}
					<i class="i-ph-trending-down"></i>
				{/if}
				{change.value}
			</span>
		{/if}
	</div>
	<div class="stat-value">{value}</div>
	<div class="stat-label">{label}</div>
</div>

<style>
	.stat-card {
		background: var(--color-surface);
		border-radius: var(--radius-panel, var(--radius-xl));
		border: 1px solid var(--color-border);
		padding: 24px;
		transition: all var(--transition-base);
		position: relative;
		overflow: hidden;
	}

	.stat-card::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		background: var(--stat-card-accent-bg, var(--gradient-primary));
		opacity: 0;
		transition: opacity var(--transition-fast);
	}

	.stat-card:hover {
		transform: var(--stat-card-hover-transform, translateY(-6px));
		box-shadow: var(--stat-card-hover-shadow, var(--shadow-lg));
	}

	.stat-card:hover::before {
		opacity: 1;
	}

	/* Hierarchy level indicators */
	.stat-card[data-level='system']::before {
		background: var(--color-text-muted);
		opacity: 1;
	}

	.stat-card[data-level='tenant']::before {
		background: var(--stat-card-accent-bg, var(--gradient-primary));
		opacity: 1;
	}

	.stat-card[data-level='client']::before {
		background: var(--color-warning);
		opacity: 1;
	}

	.stat-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.stat-icon {
		width: 48px;
		height: 48px;
		border-radius: var(--stat-icon-radius, var(--radius-control, var(--radius-lg)));
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.stat-icon :global(i) {
		width: 24px;
		height: 24px;
		font-size: 24px;
	}

	.stat-icon.purple {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.stat-icon.green {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.stat-icon.pink {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.stat-icon.orange {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.stat-change {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: var(--status-badge-radius, var(--radius-full));
	}

	.stat-change.positive {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.stat-change.negative {
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
		color: var(--color-danger);
	}

	.stat-change :global(i) {
		width: 12px;
		height: 12px;
		font-size: 12px;
	}

	.stat-value {
		font-family: var(--font-display);
		font-size: 2rem;
		font-weight: 800;
		color: var(--color-text);
		line-height: 1.1;
	}

	.stat-label {
		font-size: 0.875rem;
		color: var(--color-text-subtle);
		margin-top: 4px;
	}
</style>
