<script lang="ts">
	import { goto } from '$app/navigation';
	import { settingsLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpPlatformProfiles } from '#lib/api/platform-profiles.js';
	import { httpSettings } from '#lib/api/settings.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';
	import PlatformProfilesPage from '#lib/pages/authentication/platform/PlatformProfilesPage.svelte';

	const BASE = '/admin/platform/authentication/session-profiles';
	const client = httpPlatformProfiles('session');
	// As the Admin API decides it: the platform's `profiles` settings (a global assignment).
	const level = $derived(settingsLevel(adminAccess.current, 'profiles', 'platform'));
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head><title>{t('pp.title.session')} — {t('app.brand')}</title></svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	<PlatformProfilesPage
		kind="session"
		profiles={client}
		settings={httpSettings}
		canWrite={level === 'edit'}
		{hrefOf}
		onopen={(id) => goto(hrefOf(id))}
	/>
{/if}
