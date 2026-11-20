<script lang="ts">
	import AuthPageShell from '#lib/components/AuthPageShell.svelte';
	import FederationPickerView, { type FederationIdP } from '#lib/views/FederationPickerView.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { onDestroy } from 'svelte';

	interface PageData {
		sourceId: string;
		displayName: string;
		items: FederationIdP[];
		truncated: boolean;
		loadFailed: boolean;
		forwarded: Record<string, string>;
	}

	let { data }: { data: PageData } = $props();

	let query = $state('');
	let items = $state<FederationIdP[] | null>(null);
	let truncated = $state<boolean | null>(null);
	let loading = $state(false);
	let loadFailed = $state<boolean | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;

	const shownItems = $derived(items ?? data.items);
	const shownTruncated = $derived(truncated ?? data.truncated);
	const shownFailed = $derived(loadFailed ?? data.loadFailed);

	/** The newest request is the only one allowed to touch the state, so a slow, older answer
	 * (or the end of an aborted one) can neither overwrite a newer list nor clear its busy flag. */
	let latest = 0;

	function search(next: string) {
		clearTimeout(timer);
		// An answer for text the user has already typed past is no longer wanted.
		controller?.abort();
		timer = setTimeout(() => void run(next), 300);
	}

	async function run(next: string) {
		controller?.abort();
		const mine = ++latest;
		const own = new AbortController();
		controller = own;
		loading = true;
		try {
			const response = await fetch(
				`/saml/sp/federation/${encodeURIComponent(data.sourceId)}/idps?limit=20&q=${encodeURIComponent(next)}`,
				{ signal: own.signal }
			);
			if (!response.ok) throw new Error('search_failed');
			const body = (await response.json()) as {
				items: FederationIdP[];
				truncated: boolean;
			};
			if (mine !== latest) return;
			items = body.items;
			truncated = body.truncated;
			loadFailed = false;
		} catch (cause) {
			if (mine !== latest) return;
			if (cause instanceof DOMException && cause.name === 'AbortError') return;
			loadFailed = true;
		} finally {
			if (mine === latest) loading = false;
		}
	}

	/** Hand the chosen institution to the SAML start, with what the sign-in screen sent here. */
	function select(entityId: string) {
		const target = new URL('/saml/sp/login', window.location.origin);
		target.searchParams.set('federation', data.sourceId);
		target.searchParams.set('entityID', entityId);
		for (const [name, value] of Object.entries(data.forwarded)) {
			target.searchParams.set(name, value);
		}
		window.location.href = target.toString();
	}

	onDestroy(() => {
		clearTimeout(timer);
		controller?.abort();
	});
</script>

<svelte:head>
	<title>{$LL.federation_picker_pageTitle()}</title>
</svelte:head>

<AuthPageShell>
	<FederationPickerView
		federationName={data.displayName}
		items={shownItems}
		bind:query
		{loading}
		loadFailed={shownFailed}
		truncated={shownTruncated}
		onQuery={search}
		onSelect={select}
	/>
</AuthPageShell>
