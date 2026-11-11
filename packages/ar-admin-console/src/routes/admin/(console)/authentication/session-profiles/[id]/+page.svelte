<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { settingsLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpSessionProfiles } from '#lib/api/session-profiles.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import SessionProfilePage from '#lib/pages/authentication/SessionProfilePage.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';

	const BASE = '/admin/authentication/session-profiles';
	const id = $derived(page.params.id ?? 'new');
	// As the Admin API decides it: by the session settings' level (SSO is held with them).
	const level = $derived(settingsLevel(adminAccess.current, 'session', 'tenant'));
	const canWrite = $derived(level === 'edit');
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

<svelte:head><title>{t('sp.list.title')} — {t('app.brand')}</title></svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	{#key tenantScope.tenantId}
		<SessionProfilePage
			client={httpSessionProfiles}
			{id}
			{canWrite}
			listHref={BASE}
			oncreated={created}
			bind:dirty
		/>
	{/key}
{/if}

<LeaveConfirm open={pending !== null} onleave={leave} onstay={() => (pending = null)} />
