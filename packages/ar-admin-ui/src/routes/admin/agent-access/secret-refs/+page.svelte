<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentSecretReference } from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let items: AgentSecretReference[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	const canCreate = $derived(adminAuth.hasPermission('admin:auth_config_plans:create'));
	let revoking = $state('');

	async function revoke(item: AgentSecretReference) {
		if (!confirm($LL.admin_agent_access_secret_ref_revoke_confirm())) return;
		revoking = item.id;
		error = '';
		try {
			await adminAgentAccessAPI.revokeSecretReference(item.id);
			items = items.map((candidate) =>
				candidate.id === item.id
					? { ...candidate, status: 'revoked', revokedAt: Date.now() }
					: candidate
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			revoking = '';
		}
	}

	onMount(async () => {
		try {
			items = await adminAgentAccessAPI.listSecretReferences();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_secret_refs_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_secret_refs_title()}
		description={$LL.admin_agent_access_secret_refs_description()}
	>
		{#snippet actions()}
			{#if canCreate}
				<a class="btn btn-primary" href="/admin/agent-access/secret-refs/new"
					>{$LL.admin_agent_access_secret_ref_new()}</a
				>
			{/if}
		{/snippet}
	</AdminPageHeader>
	<AgentAccessNav />
	{#if loading}
		<div class="state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<AdminSection>
			<AdminDataTable>
				<thead>
					<tr>
						<th>{$LL.admin_agent_access_secret_ref_purpose()}</th>
						<th>{$LL.admin_agent_access_secret_ref_resource_type()}</th>
						<th>{$LL.admin_agent_access_col_status()}</th>
						<th>{$LL.admin_agent_access_created()}</th>
						<th>{$LL.admin_agent_access_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each items as item (item.id)}
						<tr>
							<td><strong>{item.purpose}</strong><small>{item.id}</small></td>
							<td>{item.resourceType}{item.resourceId ? ` · ${item.resourceId}` : ''}</td>
							<td>{item.status}</td>
							<td>{new Date(item.createdAt).toLocaleString()}</td>
							<td>
								{#if canCreate && item.status === 'active'}
									<button
										class="btn btn-secondary"
										disabled={revoking === item.id}
										onclick={() => revoke(item)}
										>{$LL.admin_agent_access_secret_ref_revoke()}</button
									>
								{/if}
							</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="state">{$LL.admin_agent_access_secret_ref_empty()}</td></tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	small {
		display: block;
		margin-top: 3px;
		color: var(--color-text-muted);
	}
</style>
