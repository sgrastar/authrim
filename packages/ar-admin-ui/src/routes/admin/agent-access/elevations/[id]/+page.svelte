<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { adminAgentAccessAPI, type AgentElevationReview } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let elevation: AgentElevationReview | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let freshAuthRequired = $state(false);

	function formatDate(value: number): string {
		return new Date(value).toLocaleString();
	}

	function reauthenticationHref(): string {
		const id = $page.params.id ?? '';
		const returnTo = `/admin/agent-access/elevations/${encodeURIComponent(id)}`;
		return `/admin/login?return_to=${encodeURIComponent(returnTo)}`;
	}

	async function load() {
		loading = true;
		error = '';
		try {
			elevation = await adminAgentAccessAPI.getElevation($page.params.id ?? '');
		} catch (caught) {
			error =
				caught instanceof Error ? caught.message : $LL.admin_agent_access_elevation_load_error();
		} finally {
			loading = false;
		}
	}

	async function decide(decision: 'approved' | 'denied') {
		if (!elevation || elevation.status !== 'pending') return;
		if (
			decision === 'approved' &&
			!window.confirm($LL.admin_agent_access_elevation_approve_confirm())
		) {
			return;
		}
		saving = true;
		error = '';
		freshAuthRequired = false;
		try {
			const result = await adminAgentAccessAPI.decideElevation(elevation.id, decision);
			elevation = { ...elevation, status: result.status };
			notice =
				result.status === 'approved'
					? $LL.admin_agent_access_elevation_approved_notice()
					: $LL.admin_agent_access_elevation_denied_notice();
		} catch (caught) {
			const message =
				caught instanceof Error ? caught.message : $LL.admin_agent_access_elevation_load_error();
			freshAuthRequired = message === 'AGENT_ELEVATION_FRESH_AUTH_REQUIRED';
			error = freshAuthRequired ? $LL.admin_agent_access_elevation_fresh_required() : message;
		} finally {
			saving = false;
		}
	}

	onMount(load);
</script>

<svelte:head><title>{$LL.admin_agent_access_elevation_title()}</title></svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_agent_access_elevation_title()}
		description={$LL.admin_agent_access_elevation_description()}
	/>
	<AgentAccessNav />

	{#if loading}
		<div class="state">{$LL.admin_agent_access_loading()}</div>
	{:else if error && !elevation}
		<div class="alert alert-error">{error}</div>
	{:else if elevation}
		{#if error}<div class="alert alert-error">{error}</div>{/if}
		{#if notice}<div class="alert alert-success">{notice}</div>{/if}
		{#if freshAuthRequired}
			<div class="reauth-card">
				<p>{$LL.admin_agent_access_elevation_fresh_help()}</p>
				<a class="btn btn-primary" href={reauthenticationHref()}
					>{$LL.admin_agent_access_elevation_reauthenticate()}</a
				>
			</div>
		{/if}

		<AdminSection title={$LL.admin_agent_access_elevation_summary()}>
			<p class="confirmation">{elevation.confirmation_summary}</p>
			<dl>
				<div>
					<dt>{$LL.admin_agent_access_elevation_status()}</dt>
					<dd>{elevation.status}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_elevation_tool()}</dt>
					<dd>{elevation.title}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_client()}</dt>
					<dd>{elevation.client_id}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_plan_actor()}</dt>
					<dd>{elevation.actor_sub}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_grant_id()}</dt>
					<dd>{elevation.grant_id}</dd>
				</div>
				<div>
					<dt>{$LL.admin_agent_access_elevation_expires()}</dt>
					<dd>{formatDate(elevation.expires_at)}</dd>
				</div>
			</dl>
		</AdminSection>

		{#if elevation.status === 'pending'}
			<p class="fresh-warning">{$LL.admin_agent_access_elevation_fresh_warning()}</p>
			<div class="actions">
				<button class="btn btn-danger" onclick={() => decide('approved')} disabled={saving}
					>{$LL.admin_agent_access_elevation_approve()}</button
				>
				<button class="btn btn-secondary" onclick={() => decide('denied')} disabled={saving}
					>{$LL.admin_agent_access_elevation_deny()}</button
				>
			</div>
		{/if}
	{/if}
</AdminPageShell>

<style>
	.state {
		padding: 32px;
		text-align: center;
		color: var(--color-text-muted);
	}
	.confirmation {
		margin: 0 0 18px;
		padding: 14px;
		border: 1px solid color-mix(in srgb, var(--color-danger) 45%, var(--color-border));
		border-radius: var(--radius-card);
		background: color-mix(in srgb, var(--color-danger) 8%, var(--color-surface));
		font-weight: 650;
	}
	dl {
		display: grid;
		gap: 10px;
		margin: 0;
	}
	dl div {
		display: grid;
		grid-template-columns: minmax(140px, 0.3fr) 1fr;
		gap: 12px;
	}
	dt {
		color: var(--color-text-muted);
	}
	dd {
		margin: 0;
		font-family: var(--font-mono);
		overflow-wrap: anywhere;
	}
	.fresh-warning,
	.reauth-card {
		margin: 16px 0;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		background: var(--color-surface-subtle);
	}
	.reauth-card p {
		margin: 0 0 12px;
	}
	.actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
	}
	@media (max-width: 620px) {
		dl div {
			grid-template-columns: 1fr;
			gap: 3px;
		}
		.actions {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
