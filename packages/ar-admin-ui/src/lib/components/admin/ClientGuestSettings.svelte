<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminClientGuestAPI,
		defaultClientGuestPolicy,
		type ClientGuestPolicy
	} from '$lib/api/admin-client-guest';
	import { ToggleSwitch } from '$lib/components';
	import AdminSection from './AdminSection.svelte';
	let { clientId } = $props<{ clientId: string }>();
	let ready = $state(false);
	let loading = $state(true);
	let saving = $state(false);
	let policy = $state<ClientGuestPolicy>(defaultClientGuestPolicy());
	let version = $state(0);
	let scopes = $state('');
	let error = $state('');
	let saved = $state(false);
	let loadedKey = $state('');
	let requestId = 0;
	const tenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	onMount(() => {
		ready = true;
	});
	$effect(() => {
		if (ready && tenantId && clientId) void load(clientId, tenantId);
	});
	async function load(id: string, tenant: string) {
		const request = ++requestId;
		loading = true;
		error = '';
		loadedKey = '';
		try {
			const result = await adminClientGuestAPI.get(id, tenant);
			if (request !== requestId) return;
			version = result.version;
			policy = result.policy;
			scopes = policy.allowedScopes.join('\n');
			loadedKey = `${tenant}:${id}`;
		} catch {
			if (request === requestId) error = $LL.admin_guestClientLoadError();
		} finally {
			if (request === requestId) loading = false;
		}
	}
	async function save() {
		if (saving || loading || !canEdit || loadedKey !== `${tenantId}:${clientId}`) return;
		const allowedScopes = [...new Set(scopes.split(/\s+/u).filter(Boolean))];
		if (
			!allowedScopes.includes('openid') ||
			allowedScopes.length > 100 ||
			allowedScopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(scope))
		) {
			error = $LL.admin_guestClientScopesInvalid();
			return;
		}
		const tenant = tenantId;
		const id = clientId;
		saving = true;
		error = '';
		saved = false;
		try {
			await adminClientGuestAPI.save(id, tenant, version, {
				...policy,
				allowedScopes,
				preserveSubOnUpgrade: true
			});
			if (tenant === tenantId && id === clientId) {
				await load(id, tenant);
				saved = true;
			}
		} catch (cause) {
			if (tenant === tenantId && id === clientId)
				error =
					cause instanceof Error && cause.message === 'guest_policy_conflict'
						? $LL.admin_guestClientConflict()
						: cause instanceof Error && cause.message === 'guest_policy_tenant_required'
							? $LL.admin_guestClientTenantRequired()
							: $LL.admin_guestClientSaveError();
		} finally {
			saving = false;
		}
	}
</script>

<AdminSection title={$LL.admin_guestClientTitle()} description={$LL.admin_guestClientDescription()}>
	{#if error}<p role="alert">{error}</p>{/if}
	{#if saved}<p role="status">{$LL.admin_guestClientSaved()}</p>{/if}
	<fieldset disabled={loading || saving || !canEdit || !loadedKey}>
		<ToggleSwitch label={$LL.admin_guestClientEnabled()} bind:checked={policy.enabled} />
		<label for="guest-client-scopes">{$LL.admin_guestClientScopes()}</label>
		<textarea id="guest-client-scopes" rows="4" bind:value={scopes}></textarea>
		<p>{$LL.admin_guestClientScopeHint()}</p>
		<button type="button" onclick={save}>{$LL.admin_guestClientSave()}</button>
	</fieldset>
</AdminSection>

<style>
	fieldset {
		border: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	textarea {
		width: 100%;
		font: inherit;
		padding: 0.75rem;
		border: 1px solid var(--color-border, #cbd5e1);
		border-radius: 0.375rem;
		background: transparent;
		color: inherit;
	}
	p {
		margin: 0;
		font-size: 0.875rem;
	}
	button {
		justify-self: start;
		padding: 0.625rem 1rem;
		border-radius: 0.375rem;
		background: var(--color-primary, #2563eb);
		color: white;
	}
</style>
