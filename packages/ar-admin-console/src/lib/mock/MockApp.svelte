<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { i18n } from '$lib/i18n/i18n.svelte';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { persona } from '$lib/access/personas';
	import AppShell from '$lib/shell/AppShell.svelte';
	import { isStandalonePath, resolveNavPath } from '$lib/shell/nav';
	import PlaceholderPage from '$lib/shell/PlaceholderPage.svelte';
	import { overrideLanguageChange } from '$lib/shell/language';
	import type { ScopeOption } from '$lib/shell/ScopeSwitcher.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import { mockAccount, mockNotifications, mockScopes } from './fixtures/shell';
	import { consoleToMockHref, DEFAULT_PERSONA, mockToConsolePath, withPersona } from './paths';
	import { mockPageFor } from './registry';

	/**
	 * The container of the whole-console mock: the real shell (header, categories, left
	 * navigation) around pages made of parts and sample data, with no API behind any of it.
	 * It lives at `/mock` in the dev server only and is left out of production builds
	 * (`check:dev-mock-guard` looks for the sentinel below). See README.md in this folder.
	 */
	const MOCK_APP_SENTINEL = '__AUTHRIM_ADMIN_UI_MOCK_APP_SENTINEL__';

	// Look at the console as one kind of admin: /mock?persona=tenant|support|viewer.
	// Set before the first render so the navigation is already filtered.
	const personaId = $derived(page.url.searchParams.get('persona') ?? DEFAULT_PERSONA);
	$effect.pre(() => {
		adminAccess.setOverride(persona(personaId).access);
		return () => adminAccess.setOverride(null);
	});

	// The language switch posts to the server to keep a cookie; the mock has no server, so it only
	// changes the language in this page.
	$effect.pre(() => overrideLanguageChange((locale) => i18n.set(locale)));

	const consolePath = $derived(mockToConsolePath(page.url.pathname));
	const known = $derived(resolveNavPath(consolePath));
	const location = $derived(known ?? resolveNavPath('/admin')!);
	const standalone = $derived(isStandalonePath(consolePath));
	const loader = $derived(known ? mockPageFor(consolePath) : undefined);

	let tenant = $state('acme');
	let dismissed = $state<string[]>([]);
	const notifications = $derived(mockNotifications.filter((item) => !dismissed.includes(item.id)));
	const currentScopeId = $derived(location.kind === 'platform' ? 'platform' : tenant);

	async function selectScope(option: ScopeOption) {
		if (option.kind === 'platform') {
			await goto(withPersona('/mock/platform', personaId));
			return;
		}
		tenant = option.id;
		if (location.kind === 'platform') await goto(withPersona('/mock', personaId));
	}

	/**
	 * The shell builds `/admin/...` links. Point each one into the mock as it is about to be used
	 * (hover, focus, press, context menu), so a new tab, a middle click or "copy link" stays in the
	 * mock as well as a plain click does.
	 */
	function pointIntoMock(event: Event) {
		const anchor = (event.target as Element | null)?.closest?.('a');
		if (!anchor) return;
		const target = consoleToMockHref(anchor.getAttribute('href') ?? '', personaId);
		if (target) anchor.setAttribute('href', target);
	}

	/** A plain click moves inside the app without a full load. */
	function keepInMock(event: MouseEvent) {
		if (event.defaultPrevented || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = (event.target as Element).closest('a');
		if (!anchor || (anchor.target && anchor.target !== '_self')) return;
		pointIntoMock(event);
		const href = anchor.getAttribute('href') ?? '';
		if (!/^\/mock(?=$|[/?#])/.test(href)) return;
		event.preventDefault();
		void goto(href);
	}
</script>

<svelte:head>
	<title>Mock — Authrim</title>
</svelte:head>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="mock"
	data-mock-app={MOCK_APP_SENTINEL}
	onclick={keepInMock}
	onpointerover={pointIntoMock}
	onpointerdown={pointIntoMock}
	onfocusin={pointIntoMock}
	oncontextmenu={pointIntoMock}
>
	<AppShell
		{location}
		scopes={mockScopes}
		{currentScopeId}
		onscope={selectScope}
		account={mockAccount}
		onsignout={() => {}}
		{standalone}
		{notifications}
		ondismiss={(id) => (dismissed = [...dismissed, id])}
	>
		<p class="mock__note" role="note">
			<strong>Mock</strong>
			Not connected to any API. Everything on these pages is sample data.
		</p>
		{#key consolePath}
			{#if !known}
				<Page>
					<EmptyState
						icon="question"
						title="No such page in the navigation"
						description={consolePath}
					/>
				</Page>
			{:else if loader}
				{#await loader() then module}
					{@const MockPage = module.default}
					<MockPage />
				{/await}
			{:else}
				<PlaceholderPage {location} />
			{/if}
		{/key}
	</AppShell>
</div>

<style>
	.mock__note {
		display: flex;
		gap: var(--space-related);
		align-items: baseline;
		margin: 0;
		padding: 6px var(--space-page-x);
		border-bottom: 1px solid var(--border);
		background: var(--bg-hover);
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.mock__note strong {
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}
</style>
