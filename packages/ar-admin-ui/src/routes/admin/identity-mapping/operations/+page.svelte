<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingPolicySummary
	} from '$lib/api/admin-identity-mapping';

	let policies = $state<IdentityMappingPolicySummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let rollbackState = $state<Record<string, string>>({});
	let confirmRollbackId = $state<string | null>(null);
	let policySetId = $state('');
	let policyVersionId = $state('');
	let catalogVersionId = $state('');
	let snapshotId = $state('');
	let operationStatus = $state<string | null>(null);
	let operationBusy = $state(false);

	onMount(() => {
		void loadPolicies();
	});

	async function loadPolicies() {
		loading = true;
		errorMessage = null;
		try {
			const result = await adminIdentityMappingAPI.listPolicies();
			policies = result.policies;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load policy operations';
		} finally {
			loading = false;
		}
	}

	async function rollbackPolicy(policy: IdentityMappingPolicySummary) {
		if (confirmRollbackId !== policy.id) {
			confirmRollbackId = policy.id;
			rollbackState = { ...rollbackState, [policy.id]: 'Confirm rollback to continue' };
			return;
		}
		rollbackState = { ...rollbackState, [policy.id]: 'Rolling back' };
		try {
			await adminIdentityMappingAPI.rollbackPolicy(policy.id);
			confirmRollbackId = null;
			rollbackState = { ...rollbackState, [policy.id]: 'Rollback requested' };
			await loadPolicies();
		} catch (error) {
			rollbackState = {
				...rollbackState,
				[policy.id]: error instanceof Error ? error.message : 'Rollback failed'
			};
		}
	}

	async function runPolicyOperation(action: 'publish' | 'compile' | 'activate') {
		operationBusy = true;
		operationStatus = null;
		try {
			if (!policySetId.trim() || !policyVersionId.trim()) {
				throw new Error('Policy set ID and version ID are required');
			}
			if (action === 'publish') {
				await adminIdentityMappingAPI.publishPolicyVersion(policySetId.trim(), policyVersionId.trim());
			} else if (action === 'compile') {
				if (!catalogVersionId.trim()) {
					throw new Error('Catalog version ID is required for compile');
				}
				await adminIdentityMappingAPI.compilePolicyVersion(policySetId.trim(), policyVersionId.trim(), {
					catalogVersionId: catalogVersionId.trim(),
					metadata: { source: 'admin-ui-operations' }
				});
			} else {
				if (!snapshotId.trim()) {
					throw new Error('Snapshot ID is required for activation');
				}
				await adminIdentityMappingAPI.activatePolicyVersion(policySetId.trim(), policyVersionId.trim(), {
					snapshotId: snapshotId.trim(),
					activationScope: { kind: 'tenant' }
				});
			}
			operationStatus = `${action} requested`;
			await loadPolicies();
		} catch (error) {
			operationStatus = error instanceof Error ? error.message : `${action} failed`;
		} finally {
			operationBusy = false;
		}
	}

	const activePolicies = $derived(
		policies.filter((policy) => policy.lifecycleState === 'active').length
	);
	const degradedPolicies = $derived(
		policies.filter((policy) => ['draft', 'scheduled'].includes(policy.lifecycleState)).length
	);
</script>

<svelte:head>
	<title>Identity Mapping Operations - Authrim Admin</title>
</svelte:head>

<div class="operations-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Operations</h1>
			<p class="summary">
				Review activation status, rollback readiness, and degraded policy states before promoting a
				compiled mapping bundle.
			</p>
		</div>
		<div class="status-panel">
			<div>
				<span>Active policies</span>
				<strong>{activePolicies}</strong>
			</div>
			<div>
				<span>Needs attention</span>
				<strong>{degradedPolicies}</strong>
			</div>
		</div>
	</div>

	<section class="policy-panel">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">Policy Activation</p>
				<h2>Activation and rollback status</h2>
			</div>
			<button type="button" onclick={loadPolicies} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading policy operations.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else if policies.length === 0}
			<div class="empty-state">No mapping policies are registered yet.</div>
		{:else}
			<div class="policy-list">
				{#each policies as policy (policy.id)}
					<article class="policy-row">
						<div>
							<p>{policy.policyKey}</p>
							<h3>{policy.displayName}</h3>
							<span>{policy.description ?? 'No description'}</span>
						</div>
						<div class="policy-actions">
							<strong class:active={policy.lifecycleState === 'active'}
								>{policy.lifecycleState}</strong
							>
							<button type="button" onclick={() => rollbackPolicy(policy)}>
								{confirmRollbackId === policy.id ? 'Confirm rollback' : 'Request rollback'}
							</button>
							{#if rollbackState[policy.id]}
								<span>{rollbackState[policy.id]}</span>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</section>

	<section class="policy-panel">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">Action Panel</p>
				<h2>Publish, compile, and activate a policy version</h2>
			</div>
		</div>

		<div class="action-grid">
			<label>
				<span>Policy set ID</span>
				<input bind:value={policySetId} placeholder="mapping policy set id" />
			</label>
			<label>
				<span>Policy version ID</span>
				<input bind:value={policyVersionId} placeholder="mapping policy version id" />
			</label>
			<label>
				<span>Catalog version ID</span>
				<input bind:value={catalogVersionId} placeholder="required for compile" />
			</label>
			<label>
				<span>Snapshot ID</span>
				<input bind:value={snapshotId} placeholder="required for activate" />
			</label>
		</div>

		<div class="action-row">
			<button type="button" onclick={() => runPolicyOperation('publish')} disabled={operationBusy}>
				Publish
			</button>
			<button type="button" onclick={() => runPolicyOperation('compile')} disabled={operationBusy}>
				Compile
			</button>
			<button type="button" onclick={() => runPolicyOperation('activate')} disabled={operationBusy}>
				Activate
			</button>
			{#if operationStatus}
				<span>{operationStatus}</span>
			{/if}
		</div>
	</section>
</div>

<style>
	.operations-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.policy-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow,
	.policy-row p,
	.status-panel span {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1,
	h2,
	h3,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
		line-height: 1.2;
	}

	h2,
	h3,
	.policy-actions strong,
	.status-panel strong {
		color: var(--text-primary);
	}

	h2 {
		font-size: 18px;
	}

	h3 {
		font-size: 16px;
	}

	.summary,
	.policy-row span,
	.policy-actions span {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 760px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.policy-panel,
	.empty-state,
	.policy-row {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 300px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong {
		display: block;
		margin-top: 4px;
		font-size: 20px;
	}

	.policy-panel {
		padding: 16px;
	}

	button {
		min-height: 36px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		font-weight: 800;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		margin-top: 14px;
		padding: 18px;
		color: var(--text-secondary);
	}

	.policy-list {
		display: grid;
		gap: 10px;
		margin-top: 14px;
	}

	.policy-row {
		padding: 14px;
	}

	.policy-actions {
		min-width: 180px;
		display: grid;
		justify-items: end;
		gap: 8px;
	}

	.action-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
		margin-top: 14px;
	}

	label {
		display: grid;
		gap: 6px;
	}

	label span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	input {
		min-height: 36px;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-input);
	}

	.action-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
	}

	.action-row span {
		color: var(--text-secondary);
		font-size: 13px;
	}

	.policy-actions strong {
		padding: 4px 9px;
		border-radius: 999px;
		background: var(--bg-muted);
		font-size: 12px;
	}

	.policy-actions strong.active {
		color: #047857;
		background: rgba(16, 185, 129, 0.14);
	}

	@media (max-width: 900px) {
		.page-heading,
		.panel-heading,
		.policy-row {
			display: grid;
		}

		.status-panel,
		.policy-actions,
		.action-grid {
			min-width: 0;
			justify-items: stretch;
		}

		.action-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
