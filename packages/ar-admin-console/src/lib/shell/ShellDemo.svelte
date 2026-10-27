<script lang="ts">
	import AppShell from './AppShell.svelte';
	import { resolveNavPath } from './nav';
	import PlaceholderPage from './PlaceholderPage.svelte';
	import type { ScopeOption } from './ScopeSwitcher.svelte';
	import type { ShellNotification } from './notifications';

	/**
	 * Storybook stand-in for the console route: link clicks inside the frame update the location
	 * in place, so the category turn and scope flip can be tried without a router.
	 */
	interface Props {
		path?: string;
		/** Leave out for a header without a notification area. */
		notifications?: readonly ShellNotification[];
	}

	let { path = '/admin/users/all', notifications }: Props = $props();

	// Information is dismissed in place; the demo keeps what is left.
	let dismissed = $state<string[]>([]);
	const shown = $derived(notifications?.filter((item) => !dismissed.includes(item.id)));

	let current = $state('');
	const location = $derived(
		resolveNavPath((current || path).split('?')[0]) ?? resolveNavPath('/admin')!
	);

	const scopes: ScopeOption[] = [
		{ id: 'platform', kind: 'platform', name: 'プラットフォーム全体', mark: '◆' },
		{ id: 'acme', kind: 'tenant', name: 'Acme Corporation', mark: 'A' },
		{ id: 'globex', kind: 'tenant', name: 'Globex Inc.', mark: 'G' }
	];
	let tenant = $state('acme');

	function intercept(event: MouseEvent) {
		const anchor = (event.target as HTMLElement).closest('a');
		const href = anchor?.getAttribute('href');
		if (!href || !href.startsWith('/admin')) return;
		event.preventDefault();
		current = href;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div onclick={intercept}>
	<AppShell
		{location}
		{scopes}
		currentScopeId={location.kind === 'platform' ? 'platform' : tenant}
		onscope={(option) => {
			if (option.kind === 'platform') current = '/admin/platform';
			else {
				tenant = option.id;
				if (location.kind === 'platform') current = '/admin';
			}
		}}
		account={{ name: 'Alex Morgan', email: 'admin@example.com', initials: 'AM' }}
		onsignout={() => {}}
		notifications={shown}
		ondismiss={(id) => (dismissed = [...dismissed, id])}
	>
		{#key current}<PlaceholderPage {location} />{/key}
	</AppShell>
</div>
