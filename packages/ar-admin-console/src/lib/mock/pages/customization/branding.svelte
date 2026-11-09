<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { createFakeSchemaSetting } from '#lib/api/fake/schema-setting-fake.js';
	import ThemeEditorPage from '#lib/pages/customization/ThemeEditorPage.svelte';
	import ThemeList from '#lib/pages/customization/ThemeList.svelte';
	import { useSchemaChoices } from '#lib/pages/customization/screens/schema-choices.svelte.js';
	import { mockThemes, mockUploadAsset } from '../../fixtures/themes';
	import { mockScreens } from '../../fixtures/screens';

	// One page for the list and a theme, as the console has two routes: the address says which
	// (…/branding, …/branding/new, …/branding/<id>).
	const LIST = '/mock/customization/branding';
	const persona = $derived(page.url.searchParams.get('persona'));
	const withPersona = (path: string) => (persona ? `${path}?persona=${persona}` : path);
	const id = $derived(
		page.url.pathname.replace(/\/+$/, '').startsWith(`${LIST}/`)
			? decodeURIComponent(page.url.pathname.replace(/\/+$/, '').slice(LIST.length + 1))
			: null
	);
	const canWrite = $derived(
		hasPermission(adminAccess.current, 'admin:settings:write') ||
			hasPermission(adminAccess.current, 'admin:settings:login_ui:update')
	);
	const schema = useSchemaChoices(() => 'mock', createFakeSchemaSetting({ delay: 100 }));
	// Links on the page are console links; the mock turns them into its own when they are clicked.
	const consoleHref = (themeId: string) =>
		`/admin/customization/branding/${encodeURIComponent(themeId)}`;
	const open = (themeId: string) => goto(withPersona(`${LIST}/${encodeURIComponent(themeId)}`));
</script>

{#if id === null}
	<ThemeList client={mockThemes} {canWrite} hrefOf={consoleHref} onopen={open} />
{:else}
	<ThemeEditorPage
		client={mockThemes}
		screensClient={mockScreens}
		choices={schema.choices}
		{id}
		{canWrite}
		upload={mockUploadAsset}
		listHref="/admin/customization/branding"
		oncreated={(themeId) =>
			goto(withPersona(`${LIST}/${encodeURIComponent(themeId)}`), { replaceState: true })}
	/>
{/if}
