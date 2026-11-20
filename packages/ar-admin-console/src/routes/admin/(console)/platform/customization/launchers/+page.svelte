<script lang="ts">
	import { goto } from '$app/navigation';
	import { platformLaunchersLevel } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpPlatformLaunchers } from '#lib/api/platform-launchers.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import LauncherList from '#lib/pages/customization/launchers/LauncherList.svelte';
	import EmptyState from '#lib/ui/patterns/EmptyState.svelte';

	const BASE = '/admin/platform/customization/launchers';
	const client = httpPlatformLaunchers();
	// As the Admin API decides it: the Login UI's platform roles (a global assignment).
	const level = $derived(platformLaunchersLevel(adminAccess.current));
	const hrefOf = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
</script>

<svelte:head>
	<title>{t('ln.platform.title')} — {t('app.brand')}</title>
</svelte:head>

{#if level === 'none'}
	<EmptyState icon="lock" title={t('access.none.title')} />
{:else}
	<LauncherList {client} canWrite={level === 'edit'} {hrefOf} onopen={(id) => goto(hrefOf(id))} />
{/if}
