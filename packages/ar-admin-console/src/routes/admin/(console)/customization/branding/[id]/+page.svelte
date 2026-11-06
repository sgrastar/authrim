<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { httpLoginUiThemes, uploadLoginUiAsset } from '#lib/api/login-ui-themes.js';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ThemeEditorPage from '#lib/pages/customization/ThemeEditorPage.svelte';
	import LeaveConfirm from '#lib/ui/save/LeaveConfirm.svelte';

	const BASE = '/admin/customization/branding';
	const id = $derived(page.params.id ?? 'new');
	const canWrite = $derived(
		hasPermission(adminAccess.current, 'admin:settings:write') ||
			hasPermission(adminAccess.current, 'admin:settings:login_ui:update')
	);

	let dirty = $state(false);
	/** Where the admin was going when the page had unsaved changes. */
	let pending = $state<URL | null>(null);
	let leaving = false;

	// Unsaved changes: ask before leaving the theme (in the console; the browser asks on unload).
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

	function created(themeId: string) {
		leaving = true;
		void goto(`${BASE}/${encodeURIComponent(themeId)}`, { replaceState: true }).finally(
			() => (leaving = false)
		);
	}
</script>

<svelte:head>
	<title>{t('nav.custom.branding')} — {t('app.brand')}</title>
</svelte:head>

{#key tenantScope.tenantId}
	<ThemeEditorPage
		client={httpLoginUiThemes}
		{id}
		{canWrite}
		upload={uploadLoginUiAsset}
		listHref={BASE}
		oncreated={created}
		bind:dirty
	/>
{/key}

<LeaveConfirm open={pending !== null} onleave={leave} onstay={() => (pending = null)} />
