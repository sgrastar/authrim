<script lang="ts">
	import { goto } from '$app/navigation';
	import { adminAgentAccessAPI } from '$lib/api/admin-agent-access';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AgentAccessNav
	} from '$lib/components/admin';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { LL } from '$i18n/i18n-svelte';

	let resourceType = $state('oauth_client');
	let resourceId = $state('');
	let purpose = $state('');
	let providerKey = $state('');
	let saving = $state(false);
	let error = $state('');
	const providerPrefix = $derived(`tenant:${adminAuth.user?.tenantId ?? '{tenant_id}'}:agent:`);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!resourceType.trim() || !purpose.trim() || !providerKey.trim()) return;
		saving = true;
		error = '';
		try {
			await adminAgentAccessAPI.createSecretReference({
				resource_type: resourceType.trim(),
				...(resourceId.trim() ? { resource_id: resourceId.trim() } : {}),
				purpose: purpose.trim(),
				provider_key: providerKey.trim()
			});
			await goto('/admin/agent-access/secret-refs');
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_agent_access_load_error();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{$LL.admin_agent_access_secret_ref_new()}</title></svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		title={$LL.admin_agent_access_secret_ref_new()}
		description={$LL.admin_agent_access_secret_refs_description()}
	/>
	<AgentAccessNav />
	{#if error}<div class="alert alert-error">{error}</div>{/if}
	<form onsubmit={submit}>
		<AdminSection>
			<label
				>{$LL.admin_agent_access_secret_ref_resource_type()}<input
					bind:value={resourceType}
					required
				/></label
			>
			<label
				>{$LL.admin_agent_access_secret_ref_resource_id()}<input bind:value={resourceId} /></label
			>
			<label
				>{$LL.admin_agent_access_secret_ref_purpose()}<input bind:value={purpose} required /></label
			>
			<label
				>{$LL.admin_agent_access_secret_ref_provider_key()}<input
					bind:value={providerKey}
					required
					autocomplete="off"
					placeholder={providerPrefix}
				/></label
			>
			<p class="help">{$LL.admin_agent_access_secret_ref_provider_help()}</p>
		</AdminSection>
		<div class="actions">
			<a class="btn btn-secondary" href="/admin/agent-access/secret-refs"
				>{$LL.admin_agent_access_cancel()}</a
			>
			<button class="btn btn-primary" disabled={saving}
				>{$LL.admin_agent_access_secret_ref_create()}</button
			>
		</div>
	</form>
</AdminPageShell>

<style>
	form,
	label {
		display: grid;
		gap: 7px;
	}
	form {
		gap: 18px;
	}
	label + label {
		margin-top: 16px;
	}
	input {
		width: 100%;
		padding: 9px 11px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
	}
	.help {
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
