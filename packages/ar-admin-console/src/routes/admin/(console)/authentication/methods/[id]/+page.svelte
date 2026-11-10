<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpAuthenticationMethodProfiles } from '#lib/api/authentication-method-profiles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AuthenticationMethodProfilePage from '#lib/pages/authentication/AuthenticationMethodProfilePage.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';

	const BASE = '/admin/authentication/methods';
	const id = $derived(page.params.id ?? 'new');
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	let dirty = $state(false);
	let pending = $state<URL | null>(null);
	let leaving = false;

	beforeNavigate((navigation) => {
		if (!dirty || leaving) return;
		if (navigation.type === 'leave') {
			navigation.cancel();
			return;
		}
		navigation.cancel();
		pending = navigation.to?.url ?? null;
	});
	function leave() {
		const target = pending;
		pending = null;
		if (!target) return;
		leaving = true;
		void goto(target).finally(() => (leaving = false));
	}
	function created(profileId: string) {
		leaving = true;
		void goto(`${BASE}/${encodeURIComponent(profileId)}`, { replaceState: true }).finally(
			() => (leaving = false)
		);
	}
</script>

<svelte:head><title>{t('am.list.title')} — {t('app.brand')}</title></svelte:head>

{#key tenantScope.tenantId}
	<AuthenticationMethodProfilePage
		client={httpAuthenticationMethodProfiles}
		{id}
		{canWrite}
		listHref={BASE}
		oncreated={created}
		bind:dirty
	/>
{/key}

<LeaveConfirm open={pending !== null} onleave={leave} onstay={() => (pending = null)} />
