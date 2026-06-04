<script lang="ts">
	import type { ApprovalStepGuideResult } from '$lib/api/admin-approvals';
	import { LL } from '$i18n/i18n-svelte';

	type Props = {
		guide: ApprovalStepGuideResult;
		onIssueFallback?: ((method: string) => void) | null;
	};

	let { guide, onIssueFallback = null }: Props = $props();

	function formatMethods(methods: string[]): string {
		return methods.length > 0 ? methods.join(', ') : '-';
	}

	function getFallbackMethods(): string[] {
		if (!guide.guide) return [];
		return guide.guide.acceptable_methods.filter((method) => method !== guide.guide?.method);
	}
</script>

<div class="guide-card">
	{#if guide.guide}
		<div class="guide-header">
			<div>
				<h4>{guide.guide.guidance_title}</h4>
				<p>{guide.guide.guidance_body}</p>
			</div>
			<span class="guide-badge">{guide.guide.method}</span>
		</div>
		<div class="guide-grid">
			<div>
				<strong>{$LL.admin_approvals_mode()}</strong>
				<span>{guide.guide.mode}</span>
			</div>
			<div>
				<strong>{$LL.admin_approvals_channel()}</strong>
				<span>{guide.guide.transport_channel ?? '-'}</span>
			</div>
			<div>
				<strong>{$LL.admin_approvals_available_methods()}</strong>
				<span>{formatMethods(guide.guide.acceptable_methods)}</span>
			</div>
			<div>
				<strong>{$LL.admin_approvals_selection_source()}</strong>
				<span>{guide.selection_source ?? '-'}</span>
			</div>
		</div>
		{#if guide.guide.fallback_note}
			<div class="guide-note">{guide.guide.fallback_note}</div>
		{/if}
		{#if onIssueFallback && getFallbackMethods().length > 0}
			<div class="fallback-actions">
				{#each getFallbackMethods() as method (method)}
					<button class="fallback-button" type="button" onclick={() => onIssueFallback?.(method)}>
						{$LL.admin_approvals_issue_method({ method })}
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		<div class="guide-error">
			{guide.resolution_error ?? $LL.admin_approvals_unable_resolve_guide()}
		</div>
	{/if}
</div>

<style>
	.guide-card {
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
		padding: 0.85rem;
		background: color-mix(in srgb, var(--color-surface-elevated) 70%, white);
	}

	.guide-header {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: flex-start;
		margin-bottom: 0.75rem;
	}

	.guide-header h4 {
		margin: 0 0 0.25rem;
		font-size: 0.95rem;
	}

	.guide-header p {
		margin: 0;
		color: var(--color-text-secondary);
		font-size: 0.88rem;
	}

	.guide-badge {
		border-radius: 999px;
		padding: 0.25rem 0.6rem;
		background: var(--color-surface-default);
		color: var(--color-text-primary);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.guide-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 0.65rem 0.9rem;
	}

	.guide-grid div {
		display: grid;
		gap: 0.15rem;
	}

	.guide-grid strong {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.guide-note {
		margin-top: 0.75rem;
		padding: 0.65rem 0.75rem;
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-warning-50) 65%, white);
		color: var(--color-warning-800);
		font-size: 0.87rem;
	}

	.guide-error {
		color: var(--color-danger-700);
		font-size: 0.9rem;
	}

	.fallback-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.75rem;
	}

	.fallback-button {
		border: 1px solid var(--color-border-default);
		background: var(--color-surface-default);
		color: var(--color-text-primary);
		border-radius: 999px;
		padding: 0.45rem 0.8rem;
		font-weight: 700;
		cursor: pointer;
	}
</style>
