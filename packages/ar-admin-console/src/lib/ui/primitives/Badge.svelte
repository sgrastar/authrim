<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		/** `changed`: changed, not saved yet (the change colour). */
		tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'changed';
		/** Leading status dot. */
		dot?: boolean;
		children: Snippet;
	}

	let { tone = 'neutral', dot = false, children }: Props = $props();
</script>

<span class="badge badge--{tone}">
	{#if dot}<span class="badge__dot"></span>{/if}
	{@render children()}
</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 8px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
	}

	.badge--success {
		border-color: color-mix(in srgb, var(--success) 22%, transparent);
		background: var(--success-bg);
		color: var(--success);
	}

	.badge--warning {
		border-color: color-mix(in srgb, var(--warning) 22%, transparent);
		background: var(--warning-bg);
		color: var(--warning);
	}

	.badge--danger {
		border-color: color-mix(in srgb, var(--danger) 22%, transparent);
		background: var(--danger-bg);
		color: var(--danger);
	}

	.badge--info {
		border-color: color-mix(in srgb, var(--info) 22%, transparent);
		background: var(--info-bg);
		color: var(--info);
	}

	.badge--changed {
		border-color: var(--changed-edge);
		background: var(--changed-bg);
		color: var(--text-primary);
	}

	.badge__dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
</style>
