<script lang="ts">
	import type { ElevationGrantRecord } from '$lib/api/admin-approvals';
	import { LL } from '$i18n/i18n-svelte';

	interface Props {
		grant: ElevationGrantRecord;
	}

	let { grant }: Props = $props();

	function enforcementSummary(redactionLevel: ElevationGrantRecord['redaction_level']) {
		if (redactionLevel === 'raw') {
			return {
				title: $LL.admin_approvals_high_risk_grant(),
				body: $LL.admin_approvals_high_risk_grant_body()
			};
		}

		return {
			title: $LL.admin_approvals_standard_grant(),
			body: $LL.admin_approvals_standard_grant_body()
		};
	}

	const enforcement = $derived(enforcementSummary(grant.redaction_level));
</script>

<div class="grant-guide">
	<div class="grant-guide-header">
		<h4>{enforcement.title}</h4>
		<span class="grant-guide-badge">{grant.redaction_level}</span>
	</div>
	<p>{enforcement.body}</p>
	<div class="grant-guide-grid">
		<div>
			<strong>{$LL.admin_approvals_audience()}</strong>
			<span>{grant.target_audience}</span>
		</div>
		<div>
			<strong>{$LL.admin_approvals_resource_class()}</strong>
			<span>{grant.resource_class}</span>
		</div>
		<div>
			<strong>{$LL.admin_approvals_actor()}</strong>
			<span>{grant.actor_subject_type} · {grant.actor_subject_id}</span>
		</div>
		<div>
			<strong>{$LL.admin_approvals_scope()}</strong>
			<span class="monospace">{grant.scope_canonical}</span>
		</div>
	</div>
</div>

<style>
	.grant-guide {
		margin-top: 0.75rem;
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
		padding: 0.85rem;
		background: color-mix(in srgb, var(--color-success-50) 35%, white);
	}

	.grant-guide-header {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.grant-guide-header h4 {
		margin: 0;
		font-size: 0.95rem;
	}

	.grant-guide-badge {
		border-radius: 999px;
		padding: 0.25rem 0.55rem;
		background: var(--color-success-100);
		color: var(--color-success-800);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.grant-guide p {
		margin: 0.35rem 0 0.75rem;
		color: var(--color-text-secondary);
		font-size: 0.88rem;
	}

	.grant-guide-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 0.6rem 0.9rem;
	}

	.grant-guide-grid div {
		display: grid;
		gap: 0.15rem;
	}

	.grant-guide-grid strong {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-secondary);
	}

	.monospace {
		font-family: var(--font-family-monospace, monospace);
		word-break: break-word;
	}
</style>
