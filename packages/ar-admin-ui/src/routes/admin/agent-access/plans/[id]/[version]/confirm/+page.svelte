<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminAgentAccessAPI,
		type AgentConfigurationPlanRecord
	} from '$lib/api/admin-agent-access';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let item: AgentConfigurationPlanRecord | null = $state(null);
	let confirmationId = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let confirmed = $state(false);
	let error = $state('');

	onMount(async () => {
		confirmationId = $page.url.searchParams.get('confirmation_id') ?? '';
		if (!confirmationId) {
			error = $LL.admin_agent_access_plan_confirmation_invalid();
			loading = false;
			return;
		}
		try {
			item = await adminAgentAccessAPI.getConfigurationPlan(
				$page.params.id ?? '',
				Number($page.params.version)
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});

	async function confirm() {
		if (!item) return;
		saving = true;
		error = '';
		try {
			await adminAgentAccessAPI.confirmConfigurationPlan({
				id: item.id,
				version: item.version,
				digest: item.definitionDigest,
				confirmationId
			});
			confirmed = true;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_plan_confirm_title()}</title></svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_agent_access_plan_confirm_title()}
		description={$LL.admin_agent_access_plan_confirm_description()}
	/>
	{#if loading}
		<div class="state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if confirmed}
		<div class="alert alert-success">{$LL.admin_agent_access_plan_confirmed()}</div>
	{:else if item}
		<AdminSection title={$LL.admin_agent_access_plan_snapshot()}>
			<dl>
				<div>
					<dt>{$LL.admin_agent_access_grant_id()}</dt>
					<dd>{item.grantId}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_plan_actor()}</dt>
					<dd>{item.actorSub}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_digest()}</dt>
					<dd class="mono">{item.definitionDigest}</dd>
				</div>
			</dl>
			<pre>{JSON.stringify(
					{ definition: item.definition, diff: item.diff, validation: item.validation },
					null,
					2
				)}</pre>
		</AdminSection>
		<div class="actions">
			<a
				class="btn btn-secondary"
				href={`/admin/agent-access/plans/${encodeURIComponent(item.id)}/${item.version}`}
				>{$LL.admin_agent_access_cancel()}</a
			>
			<button class="btn btn-primary" disabled={saving} onclick={confirm}
				>{$LL.admin_agent_access_plan_confirm()}</button
			>
		</div>
	{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	dl {
		display: grid;
		gap: 10px;
	}
	dl div {
		display: grid;
		grid-template-columns: 130px 1fr;
		gap: 12px;
	}
	dt {
		color: var(--color-text-muted);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.mono,
	pre {
		font-family: var(--font-mono);
		font-size: 0.76rem;
	}
	pre {
		overflow: auto;
		max-height: 420px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-surface-subtle);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
