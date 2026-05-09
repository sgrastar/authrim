<script lang="ts">
	import type { ApprovalCompletionRequirements } from '$lib/api/admin-approvals'

	interface Props {
		requirements: ApprovalCompletionRequirements
		completionPath?: string
		artifactId?: string
	}

	let { requirements, completionPath = '', artifactId = '' }: Props = $props()

	function formatMethods(methods: string[]): string {
		return methods.length ? methods.join(', ') : '-'
	}

	function formatAssertionEndpoints(
		endpoints: ApprovalCompletionRequirements['assertion_endpoints']
	): string[] {
		if (!endpoints) return []
		return Object.entries(endpoints).map(([key, value]) => `${key}: ${value}`)
	}
</script>

<div class="guide-card">
	<div class="guide-header">
		<div>
			<h4>{requirements.guidance_title}</h4>
			<p>{requirements.guidance_body}</p>
		</div>
		<span class="guide-badge">{requirements.method}</span>
	</div>

	<div class="guide-grid">
		<div>
			<strong>Completion Mode</strong>
			<span>{requirements.mode}</span>
		</div>
		<div>
			<strong>Available Methods</strong>
			<span>{formatMethods(requirements.acceptable_methods)}</span>
		</div>
		<div>
			<strong>Portal Path</strong>
			<span class="monospace">{requirements.portal_path}</span>
		</div>
		{#if completionPath}
			<div>
				<strong>Complete Endpoint</strong>
				<span class="monospace">{completionPath}</span>
			</div>
		{/if}
		{#if artifactId}
			<div>
				<strong>Artifact ID</strong>
				<span class="monospace">{artifactId}</span>
			</div>
		{/if}
		{#if requirements.transport_channel}
			<div>
				<strong>Delivery Target</strong>
				<span>{requirements.transport_channel}</span>
			</div>
		{/if}
	</div>

	{#if requirements.fallback_note}
		<div class="guide-note">{requirements.fallback_note}</div>
	{/if}

	{#if requirements.assertion_endpoints}
		<details class="guide-details">
			<summary>Assertion Endpoints</summary>
			<ul>
					{#each formatAssertionEndpoints(requirements.assertion_endpoints) as endpoint (endpoint)}
					<li class="monospace">{endpoint}</li>
				{/each}
			</ul>
		</details>
	{/if}
</div>

<style>
	.guide-card {
		border: 1px solid var(--color-border-subtle);
		border-radius: 12px;
		padding: 0.9rem;
		background: color-mix(in srgb, var(--color-info-50) 42%, white);
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
		background: var(--color-info-100);
		color: var(--color-info-700);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.guide-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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

	.guide-details {
		margin-top: 0.75rem;
	}

	.guide-details summary {
		cursor: pointer;
		font-weight: 700;
	}

	.guide-details ul {
		margin: 0.55rem 0 0;
		padding-left: 1rem;
	}

	.monospace {
		font-family: var(--font-family-monospace, monospace);
		word-break: break-word;
	}
</style>
