<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { settingsLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpPlatformProfiles } from '#lib/api/platform-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import PlatformProfilePage from '#lib/pages/authentication/platform/PlatformProfilePage.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';

	const BASE = '/admin/platform/authentication/session-profiles';
	const client = httpPlatformProfiles('session');
	const id = $derived(page.params.id ?? 'new');
	const level = $derived(settingsLevel(adminAccess.current, 'profiles', 'platform'));
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
	function navigate(href: string, replaceState = false) {
		leaving = true;
		void goto(href, { replaceState }).finally(() => (leaving = false));
	}
</script>

<svelte:head><title>{t('pp.title.session')} — {t('app.brand')}</title></svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	<PlatformProfilePage
		kind="session"
		{client}
		{id}
		canWrite={level === 'edit'}
		listHref={BASE}
		oncreated={(profileId) => navigate(`${BASE}/${encodeURIComponent(profileId)}`, true)}
		ondeleted={() => navigate(BASE)}
		bind:dirty
	/>
{/if}

<LeaveConfirm open={pending !== null} onleave={leave} onstay={() => (pending = null)} />
