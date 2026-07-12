<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		status: 'active' | 'inactive' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
		label?: string;
		showDot?: boolean;
	}

	let { status, label, showDot = true }: Props = $props();

	const statusLabels = {
		active: () => $LL.common_status_active(),
		inactive: () => $LL.common_status_inactive(),
		success: () => $LL.common_status_success(),
		warning: () => $LL.common_status_warning(),
		danger: () => $LL.common_status_error(),
		info: () => $LL.common_status_info(),
		neutral: () => $LL.common_status_neutral()
	};

	const displayLabel = $derived(label || statusLabels[status]());
</script>

<span class="status-badge {status}" class:no-dot={!showDot}>
	{#if showDot}
		<span class="status-dot"></span>
	{/if}
	{displayLabel}
</span>

<style>
	.status-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: var(--status-badge-radius, var(--radius-control, 20px));
		font-size: 0.75rem;
		font-weight: 500;
	}

	.status-badge.no-dot {
		padding: 6px 12px;
	}

	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: var(--status-dot-radius, 50%);
	}

	/* Active / Success */
	.status-badge.active,
	.status-badge.success {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.status-badge.active .status-dot,
	.status-badge.success .status-dot {
		background: var(--color-success);
	}

	/* Inactive / Neutral */
	.status-badge.inactive,
	.status-badge.neutral {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.status-badge.inactive .status-dot,
	.status-badge.neutral .status-dot {
		background: var(--color-text-subtle);
	}

	/* Warning */
	.status-badge.warning {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.status-badge.warning .status-dot {
		background: var(--color-warning);
	}

	/* Danger */
	.status-badge.danger {
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
		color: var(--color-danger);
	}

	.status-badge.danger .status-dot {
		background: var(--color-danger);
	}

	/* Info */
	.status-badge.info {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.status-badge.info .status-dot {
		background: var(--color-accent);
	}
</style>
