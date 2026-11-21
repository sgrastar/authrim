<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { platformLaunchersLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpPlatformLaunchers } from '#lib/api/platform-launchers.js';
	import { httpTenants } from '#lib/api/tenants.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LauncherEditorPage from '#lib/pages/customization/launchers/LauncherEditorPage.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';

	const BASE = '/admin/platform/customization/launchers';
	const client = httpPlatformLaunchers();
	const tenants = httpTenants();
	const id = $derived(page.params.id ?? 'new');
	// As the Admin API decides it: the Login UI's platform roles (a global assignment).
	const level = $derived(platformLaunchersLevel(adminAccess.current));
	const hrefOf = (launcherId: string) => `${BASE}/${encodeURIComponent(launcherId)}`;
	// Unsaved changes are asked about by the page's SaveScope.
	const created = (launcherId: string) => void goto(hrefOf(launcherId), { replaceState: true });
</script>

<svelte:head>
	<title>{t('ln.platform.title')} — {t('app.brand')}</title>
</svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	<LauncherEditorPage
		{client}
		loadSamlProviders={async () => []}
		loadTenants={async (signal) => (await tenants.list(signal)).tenants}
		{id}
		canWrite={level === 'edit'}
		listHref={BASE}
		oncreated={created}
		ondeleted={() => void goto(BASE)}
	/>
{/if}
