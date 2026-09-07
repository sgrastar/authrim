<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentBulkPlanRecord,
		type AgentBulkTenantExecutionRecord
	} from '$lib/api/admin-agent-access';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let item: AgentBulkPlanRecord | null = $state(null);
	let executions: AgentBulkTenantExecutionRecord[] = $state([]);
	let loading = $state(true);
	let working = $state(false);
	let error = $state('');
	let freshAuthRequired = $state(false);
	const id = $derived($page.params.id ?? '');
	const version = $derived(Number($page.params.version));
	function reauthenticationHref(): string {
		const returnTo = `/admin/agent-access/bulk-plans/${encodeURIComponent(id)}/${version}`;
		return `/admin/login?return_to=${encodeURIComponent(returnTo)}`;
	}
	async function load() {
		const value = await adminAgentAccessAPI.getBulkPlan(id, version);
		item = value.bulkPlan;
		executions = value.tenantExecutions;
	}
	onMount(async () => {
		try {
			await load();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
	async function action(name: 'validate' | 'start' | 'pause' | 'resume' | 'cancel') {
		if (
			!item ||
			(name === 'start' && !confirm($LL.admin_agent_access_bulk_start())) ||
			(name === 'cancel' && !confirm($LL.admin_agent_access_cancel()))
		)
			return;
		working = true;
		error = '';
		freshAuthRequired = false;
		try {
			if (name === 'start')
				await adminAgentAccessAPI.startBulkPlan(id, version, item.definitionDigest);
			else await adminAgentAccessAPI.transitionBulkPlan(id, version, name);
			await load();
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
			freshAuthRequired = message === 'AGENT_BULK_PLAN_FRESH_CONFIRMATION_REQUIRED';
			error = freshAuthRequired ? $LL.admin_agent_access_elevation_fresh_required() : message;
		} finally {
			working = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_bulk_detail()}</title></svelte:head>
<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_bulk_detail()}
		description={$LL.admin_agent_access_bulk_description()}
	/>
	<AgentAccessNav />
	{#if loading}<div class="state">
			{$LL.admin_agent_access_loading()}
		</div>{:else if error && !item}<div class="alert alert-error">{error}</div>{:else if item}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if freshAuthRequired}
			<div class="alert">
				<p>{$LL.admin_agent_access_elevation_fresh_help()}</p>
				<a class="btn btn-primary" href={reauthenticationHref()}
					>{$LL.admin_agent_access_elevation_reauthenticate()}</a
				>
			</div>
		{/if}
		<div class="actions">
			{#if item.cancelledAt}<span class="badge">cancelled</span>{/if}
			{#if !item.cancelledAt && item.status === 'draft'}<button
					class="btn btn-primary"
					disabled={working}
					onclick={() => action('validate')}>{$LL.admin_agent_access_bulk_validate()}</button
				>{/if}
			{#if !item.cancelledAt && item.status === 'ready'}<button
					class="btn btn-primary"
					disabled={working}
					onclick={() => action('start')}>{$LL.admin_agent_access_bulk_start()}</button
				>{/if}
			{#if !item.cancelledAt && item.status === 'running'}<button
					class="btn"
					disabled={working}
					onclick={() => action('pause')}>{$LL.admin_agent_access_bulk_pause()}</button
				>{/if}
			{#if !item.cancelledAt && item.status === 'paused'}<button
					class="btn btn-primary"
					disabled={working}
					onclick={() => action('resume')}>{$LL.admin_agent_access_bulk_resume()}</button
				>{/if}
			{#if !item.cancelledAt && item.status !== 'completed'}<button
					class="btn"
					disabled={working}
					onclick={() => action('cancel')}>{$LL.admin_agent_access_cancel()}</button
				>{/if}
		</div>
		<AdminSection
			><div class="summary">
				<div>
					<span>{$LL.admin_agent_access_plan_status()}</span><strong
						>{item.cancelledAt ? 'cancelled' : item.status}</strong
					>
				</div>
				<div><span>{$LL.admin_agent_access_plan_stage()}</span><strong>{item.stage}</strong></div>
				<div>
					<span>{$LL.admin_agent_access_bulk_targets()}</span><strong
						>{item.targetTenantIds?.length ?? 0}</strong
					>
				</div>
				<div>
					<span>{$LL.admin_agent_access_digest()}</span><strong class="mono"
						>{item.definitionDigest}</strong
					>
				</div>
			</div></AdminSection
		>
		<AdminSection title={$LL.admin_agent_access_bulk_executions()}
			><AdminDataTable
				><thead
					><tr
						><th>Tenant</th><th>Canary / wave</th><th>{$LL.admin_agent_access_plan_stage()}</th><th
							>{$LL.admin_agent_access_plan_status()}</th
						></tr
					></thead
				><tbody
					>{#each executions as execution (execution.id)}<tr
							><td>{execution.targetTenantId}</td><td
								>{execution.isCanary ? 'canary' : `wave ${execution.waveNumber ?? '-'}`}</td
							><td>{execution.stage}</td><td
								>{execution.status}{#if execution.failureKind}<small>{execution.failureKind}</small
									>{/if}</td
							></tr
						>{:else}<tr><td colspan="4" class="state">—</td></tr>{/each}</tbody
				></AdminDataTable
			></AdminSection
		>
		<AdminSection title={$LL.admin_agent_access_plan_snapshot()}
			><pre>{JSON.stringify(item.definition, null, 2)}</pre></AdminSection
		>
	{/if}
</AdminPageShell>

<style>
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-bottom: 16px;
	}
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	.summary {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.summary div {
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
	}
	.summary span,
	small {
		display: block;
		color: var(--color-text-muted);
		font-size: 0.76rem;
	}
	.summary strong {
		display: block;
		margin-top: 5px;
		overflow-wrap: anywhere;
	}
	.mono,
	pre {
		font-family: var(--font-mono);
		font-size: 0.76rem;
	}
	pre {
		overflow: auto;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-surface-subtle);
	}
	@media (max-width: 700px) {
		.summary {
			grid-template-columns: 1fr 1fr;
		}
	}
</style>
