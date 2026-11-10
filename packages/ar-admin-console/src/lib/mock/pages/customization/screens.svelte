<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { createFakeSchemaSetting } from '#lib/api/fake/schema-setting-fake.js';
	import ScreenCreatePage from '#lib/pages/customization/screens/ScreenCreatePage.svelte';
	import ScreenEditorPage from '#lib/pages/customization/screens/ScreenEditorPage.svelte';
	import ScreenList from '#lib/pages/customization/screens/ScreenList.svelte';
	import { useSchemaChoices } from '#lib/pages/customization/screens/schema-choices.svelte.js';
	import { mockScreens } from '../../fixtures/screens';
	import { mockAppliedThemeValues } from '../../fixtures/themes';

	// One page for the list and a screen, as the console has two routes: the address says which
	// (…/screens, …/screens/new, …/screens/<id>).
	const LIST = '/mock/customization/screens';
	const persona = $derived(page.url.searchParams.get('persona'));
	const withPersona = (path: string) => (persona ? `${path}?persona=${persona}` : path);
	const id = $derived(
		page.url.pathname.replace(/\/+$/, '').startsWith(`${LIST}/`)
			? decodeURIComponent(page.url.pathname.replace(/\/+$/, '').slice(LIST.length + 1))
			: null
	);
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const canReadResponses = $derived(hasPermission(adminAccess.current, 'admin:users:read'));
	const schema = useSchemaChoices(() => 'mock', createFakeSchemaSetting({ delay: 100 }));
	// Links on the page are console links; the mock turns them into its own when they are clicked.
	const consoleHref = (screenId: string) =>
		`/admin/customization/screens/${encodeURIComponent(screenId)}`;
	const open = (screenId: string) => goto(withPersona(`${LIST}/${encodeURIComponent(screenId)}`));
</script>

{#if id === null}
	<ScreenList client={mockScreens} {canWrite} hrefOf={consoleHref} onopen={open} />
{:else if id === 'new'}
	<ScreenCreatePage
		client={mockScreens}
		{canWrite}
		loadTheme={mockAppliedThemeValues}
		oncancel={() => goto(withPersona(LIST))}
		oncreated={(screenId) =>
			goto(withPersona(`${LIST}/${encodeURIComponent(screenId)}`), { replace: true })}
	/>
{:else}
	<ScreenEditorPage
		client={mockScreens}
		{id}
		{canWrite}
		{canReadResponses}
		loadTheme={mockAppliedThemeValues}
		schemaFields={schema.fields}
		choices={schema.choices}
		requiredAtSignUp={schema.requiredAtSignUp}
		schemaHref="/admin/access/schema-setting"
		listHref="/admin/customization/screens"
		oncreated={(screenId) =>
			goto(withPersona(`${LIST}/${encodeURIComponent(screenId)}`), { replaceState: true })}
		onopen={open}
		ondeleted={() => void goto(withPersona(LIST))}
	/>
{/if}
