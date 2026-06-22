<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminConsentPoliciesAPI, type ConsentPolicy } from '$lib/api/admin-consent-policies';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';

	let policies = $state<ConsentPolicy[]>([]);
	let loading = $state(true);
	let error = $state('');
	const canWriteSettings = $derived(adminAuth.hasPermission('admin:settings:write'));

	onMount(() => {
		loadPolicies();
	});

	async function loadPolicies() {
		loading = true;
		error = '';
		try {
			const result = await adminConsentPoliciesAPI.listPolicies();
			policies = (result.policies || []).sort((a, b) =>
				a.display_name.localeCompare(b.display_name)
			);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_policies_load_error();
		} finally {
			loading = false;
		}
	}

	function openPolicy(policyId: string) {
		goto(`/admin/consent-policies/${encodeURIComponent(policyId)}`);
	}

	function formatStatus(value: number | boolean) {
		return value
			? $LL.admin_consent_policies_status_active()
			: $LL.admin_consent_policies_status_inactive();
	}

	function formatDate(timestamp: number) {
		if (!timestamp) return '-';
		const millis = timestamp > 100000000000 ? timestamp : timestamp * 1000;
		return new Date(millis).toLocaleDateString();
	}
</script>

<svelte:head>
	<title>{$LL.admin_consent_policies_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_consent_policies_title()}
		description={$LL.admin_consent_policies_description()}
	>
		{#snippet actions()}
			{#if canWriteSettings}
				<a href="/admin/consent-policies/new" class="btn btn-primary">
					<i class="i-ph-plus" aria-hidden="true"></i>
					{$LL.admin_consent_policies_new_button()}
				</a>
			{/if}
		{/snippet}
	</AdminPageHeader>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
			<p>{$LL.admin_consent_policies_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<AdminSection>
			<div class="policy-table">
				<AdminDataTable>
					<thead>
						<tr>
							<th>{$LL.admin_consent_policies_table_policy()}</th>
							<th class="optional-column">{$LL.admin_consent_policies_table_statements()}</th>
							<th>{$LL.admin_consent_policies_table_status()}</th>
							<th class="optional-column">{$LL.admin_consent_policies_table_updated()}</th>
							<th class="text-right optional-column"></th>
						</tr>
					</thead>
					<tbody>
						{#each policies as policy (policy.id)}
							<tr
								data-clickable="true"
								onclick={() => openPolicy(policy.id)}
								onkeydown={(event) => event.key === 'Enter' && openPolicy(policy.id)}
								tabindex="0"
								role="button"
							>
								<td>
									<div class="policy-name-cell">
										<strong>{policy.display_name}</strong>
									</div>
									{#if policy.description}
										<div class="policy-description">{policy.description}</div>
									{/if}
								</td>
								<td class="optional-column">{policy.item_count || 0}</td>
								<td>
									<span class="status-badge" data-state={policy.is_active ? 'active' : 'inactive'}>
										{formatStatus(policy.is_active)}
									</span>
								</td>
								<td class="admin-muted nowrap optional-column">{formatDate(policy.updated_at)}</td>
								<td class="text-right row-action-cell optional-column" aria-hidden="true">...</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5">
									<div class="empty-state">
										<p class="empty-state-description">{$LL.admin_consent_policies_empty()}</p>
										{#if canWriteSettings}
											<a href="/admin/consent-policies/new" class="btn btn-primary">
												{$LL.admin_consent_policies_new_button()}
											</a>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.policy-name-cell {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.policy-description {
		margin-top: 4px;
		max-width: 720px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.55;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 700;
	}

	.status-badge[data-state='active'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}

	.status-badge[data-state='inactive'] {
		color: var(--color-text-muted);
	}

	.empty-state {
		padding: 28px;
		text-align: center;
	}

	.empty-state-description {
		margin: 0 0 14px;
		color: var(--color-text-muted);
	}

	@media (max-width: 720px) {
		.policy-table :global(.admin-data-table) {
			min-width: 0;
		}

		.policy-table :global(.optional-column) {
			display: none;
		}

		.policy-name-cell {
			display: grid;
			gap: 4px;
		}

		.policy-name-cell :global(.admin-mono),
		.policy-description {
			overflow-wrap: anywhere;
		}
	}
</style>
