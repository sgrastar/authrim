<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { NavLocation } from './nav';
	import Header from './Header.svelte';
	import type { ShellNotification } from './notifications';
	import NavDrawer from './NavDrawer.svelte';
	import type { ScopeOption } from './ScopeSwitcher.svelte';
	import { adminAccess } from '$lib/access/admin-access.svelte';
	import { areaColor, drawerSections, showsSubNav, subNavRows, topNavEntries } from './shell-model';
	import SubNav from './SubNav.svelte';
	import TopNav from './TopNav.svelte';

	/**
	 * The console frame: header, header categories, left nav and the page. Pages render inside
	 * `children` and never style the frame.
	 */
	interface Props {
		location: NavLocation;
		scopes: readonly ScopeOption[];
		currentScopeId: string;
		onscope: (option: ScopeOption) => void;
		account: { name: string; email?: string; initials: string };
		onsignout: () => void;
		/**
		 * A page outside the navigation (personal settings): no category is marked current and
		 * the page takes the full width.
		 */
		standalone?: boolean;
		/** Shown in the header's notification area; leave out for a header without one. */
		notifications?: readonly ShellNotification[];
		ondismiss?: (id: string) => void;
		/**
		 * A full-width strip attached under the header categories, above the left nav and the page
		 * (the mock app's "sample data" note). It sits outside the page area, so a theme that
		 * insets the page (Frosted) does not pull it away from the categories.
		 */
		banner?: Snippet;
		children: Snippet;
	}

	let {
		location,
		scopes,
		currentScopeId,
		onscope,
		account,
		onsignout,
		standalone = false,
		notifications,
		ondismiss,
		banner,
		children
	}: Props = $props();

	let drawerOpen = $state(false);
	/** Height of the banner, if there is one: the left nav and the page leave room for it. */
	let bannerHeight = $state(0);

	const entries = $derived(topNavEntries(location.kind, t));
	const rows = $derived(
		showsSubNav(location, standalone) ? subNavRows(location, t, adminAccess.current) : []
	);
	const sections = $derived(drawerSections(location, t, adminAccess.current));
	const color = $derived(areaColor(location));
</script>

<div class="app" data-scope-kind={location.kind} style:--banner-h="{bannerHeight}px">
	<a class="skip" href="#content">{t('app.skip')}</a>
	<Header
		{scopes}
		{currentScopeId}
		{onscope}
		{account}
		{onsignout}
		{notifications}
		{ondismiss}
		onmenu={() => (drawerOpen = true)}
	/>
	<TopNav
		label={t('nav.primaryLabel')}
		flipKey={location.kind}
		{entries}
		activeId={standalone ? '' : location.top.id}
	/>
	{#if banner}<div class="banner" bind:clientHeight={bannerHeight}>{@render banner()}</div>{/if}
	<div class="split" class:split--full={rows.length === 0}>
		<SubNav
			label={t(location.area.label)}
			flipKey="{location.kind}:{location.top.id}"
			{rows}
			{color}
		/>
		<main id="content" tabindex="-1" style:--scope-color={color}>
			{@render children()}
		</main>
	</div>
	<NavDrawer
		open={drawerOpen}
		{sections}
		activeSectionId={standalone ? '' : location.top.id}
		onclose={() => (drawerOpen = false)}
	/>
</div>

<style>
	.app {
		min-height: 100vh;
	}

	/* Platform scope colours the category bar so the breadth of every change stays visible. */
	.app[data-scope-kind='platform'] :global(.topnav) {
		box-shadow: inset 0 -2px 0 var(--accent-platform);
	}

	.skip {
		position: absolute;
		top: -100px;
		inset-inline-start: 12px;
		z-index: var(--z-skip-link);
		padding: 8px 12px;
		border-radius: var(--radius-control);
		background: var(--primary);
		color: var(--text-inverse);
	}

	.skip:focus {
		top: 8px;
	}

	.split {
		display: grid;
		grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
		gap: var(--shell-inset);
		align-items: start;
		min-height: calc(100vh - var(--header-h) - var(--subheader-h) - var(--banner-h, 0px));
		padding: var(--shell-inset);
	}

	.split--full {
		grid-template-columns: minmax(0, 1fr);
	}

	main {
		min-width: 0;
		outline: none;
	}

	@media (max-width: 640px) {
		.split {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
