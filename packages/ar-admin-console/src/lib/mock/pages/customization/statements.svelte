<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { hasPermission } from '#lib/access/access.js';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import {
		MOCK_CONSENT_STATEMENTS,
		createFakeConsentStatements
	} from '#lib/api/fake/consent-statements-fake.js';
	import StatementCreatePage from '#lib/pages/customization/statements/StatementCreatePage.svelte';
	import StatementEditorPage from '#lib/pages/customization/statements/StatementEditorPage.svelte';
	import StatementList from '#lib/pages/customization/statements/StatementList.svelte';

	// One page for the list and a statement, as the console has routes for each: the address says
	// which (…/statements, …/statements/new, …/statements/<id>).
	const LIST = '/mock/customization/statements';
	const client = createFakeConsentStatements({ ...MOCK_CONSENT_STATEMENTS, delay: 150 });
	const persona = $derived(page.url.searchParams.get('persona'));
	const withPersona = (path: string) => (persona ? `${path}?persona=${persona}` : path);
	const id = $derived(
		page.url.pathname.replace(/\/+$/, '').startsWith(`${LIST}/`)
			? decodeURIComponent(page.url.pathname.replace(/\/+$/, '').slice(LIST.length + 1))
			: null
	);
	const canWrite = $derived(hasPermission(adminAccess.current, 'admin:settings:write'));
	const consoleHref = (statementId: string) =>
		`/admin/customization/statements/${encodeURIComponent(statementId)}`;
	const open = (statementId: string) =>
		goto(withPersona(`${LIST}/${encodeURIComponent(statementId)}`));
</script>

{#if id === null}
	<StatementList {client} {canWrite} hrefOf={consoleHref} onopen={open} />
{:else if id === 'new'}
	<StatementCreatePage
		{client}
		{canWrite}
		listHref="/admin/customization/statements"
		oncreated={(statementId) =>
			goto(withPersona(`${LIST}/${encodeURIComponent(statementId)}`), { replaceState: true })}
	/>
{:else}
	<StatementEditorPage
		{client}
		{id}
		{canWrite}
		listHref="/admin/customization/statements"
		ondeleted={() => void goto(withPersona(LIST))}
	/>
{/if}
