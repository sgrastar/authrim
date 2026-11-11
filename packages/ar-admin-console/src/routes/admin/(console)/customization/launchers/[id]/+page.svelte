<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpLaunchers } from '#lib/api/launchers.js';
	import { httpSamlProviders } from '#lib/api/saml-providers.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LauncherEditorPage from '#lib/pages/customization/launchers/LauncherEditorPage.svelte';

	const BASE = '/admin/customization/launchers';
	const id = $derived(page.params.id ?? 'new');
	// As the Admin API decides it: launchers are tenant settings.
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const hrefOf = (launcherId: string) => `${BASE}/${encodeURIComponent(launcherId)}`;
	// Unsaved changes are asked about by the page's SaveScope.
	const created = (launcherId: string) => void goto(hrefOf(launcherId), { replaceState: true });
</script>

<svelte:head>
	<title>{t('ln.list.title')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<LauncherEditorPage
		client={httpLaunchers}
		loadSamlProviders={(signal) => httpSamlProviders.listServiceProviders(signal)}
		{id}
		{canWrite}
		listHref={BASE}
		oncreated={created}
		ondeleted={() => void goto(BASE)}
	/>
{/key}
