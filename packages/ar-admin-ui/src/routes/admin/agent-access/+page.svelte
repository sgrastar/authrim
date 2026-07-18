<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AdminAgentGrant } from '$lib/api/admin-agent-access';
	import { AdminPageHeader, AdminPageShell, AgentAccessNav } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let grants: AdminAgentGrant[] = $state([]);
	let enabled = $state(false);
	let loading = $state(true);
	let error = $state('');

	const active = $derived(grants.filter((grant) => grant.status === 'active').length);
	const suspended = $derived(grants.filter((grant) => grant.status === 'suspended').length);
	const revoked = $derived(grants.filter((grant) => grant.status === 'revoked').length);

	onMount(async () => {
		try {
			const [grantResponse, settings] = await Promise.all([
				adminAgentAccessAPI.listGrants({ limit: 100 }),
				adminAgentAccessAPI.getSettings()
			]);
			grants = grantResponse.grants;
			enabled = settings.enabled;
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			loading = false;
		}
	});
</script>

<svelte:head><title>{$LL.admin_agent_access_page_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_title()}
		description={$LL.admin_agent_access_description()}
	>
		{#snippet titleAccessory()}
			<span class="status" data-enabled={enabled}>
				{enabled ? $LL.admin_agent_access_enabled() : $LL.admin_agent_access_disabled()}
			</span>
		{/snippet}
	</AdminPageHeader>
	<AgentAccessNav />

	{#if loading}
		<div class="loading-state">{$LL.admin_agent_access_loading()}</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else}
		<section class="metric-grid" aria-label={$LL.admin_agent_access_tab_overview()}>
			<div class="metric">
				<span>{active}</span>
				<p>{$LL.admin_agent_access_active_grants()}</p>
			</div>
			<div class="metric">
				<span>{suspended}</span>
				<p>{$LL.admin_agent_access_suspended_grants()}</p>
			</div>
			<div class="metric">
				<span>{revoked}</span>
				<p>{$LL.admin_agent_access_revoked_grants()}</p>
			</div>
		</section>

		<div class="action-grid">
			<a href="/admin/agent-access/grants">
				<i class="i-ph-keyhole" aria-hidden="true"></i>
				<span>{$LL.admin_agent_access_open_grants()}</span>
				<i class="i-ph-arrow-right" aria-hidden="true"></i>
			</a>
			<a href="/admin/agent-access/settings">
				<i class="i-ph-sliders-horizontal" aria-hidden="true"></i>
				<span>{$LL.admin_agent_access_open_settings()}</span>
				<i class="i-ph-arrow-right" aria-hidden="true"></i>
			</a>
		</div>
	{/if}
</AdminPageShell>

<style>
	.status {
		display: inline-flex;
		padding: 3px 9px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text-muted);
		font-size: 0.72rem;
		font-weight: 700;
	}
	.status[data-enabled='true'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}
	.metric-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}
	.metric {
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel, var(--radius-md));
		background: var(--color-surface);
	}
	.metric span {
		font-family: var(--font-display);
		font-size: 1.7rem;
		font-weight: 750;
	}
	.metric p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}
	.action-grid {
		display: grid;
		gap: 10px;
		margin-top: 20px;
	}
	.action-grid a {
		display: grid;
		grid-template-columns: 24px 1fr 20px;
		align-items: center;
		gap: 12px;
		padding: 15px 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, var(--radius-sm));
		color: var(--color-text);
		text-decoration: none;
	}
	.action-grid a:hover {
		border-color: var(--color-accent);
		background: var(--color-surface-raised);
	}
	.loading-state {
		padding: 32px;
		color: var(--color-text-muted);
		text-align: center;
	}
	@media (max-width: 720px) {
		.metric-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
