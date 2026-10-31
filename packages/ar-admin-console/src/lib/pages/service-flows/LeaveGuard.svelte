<script lang="ts">
	import { beforeNavigate, goto } from '$app/navigation';
	import ConfirmDialog from '$lib/ui/patterns/ConfirmDialog.svelte';
	import { leaveDialog } from './connection-model';

	/**
	 * Stands in the way of every way out of the page except the wizard's own Cancel (which asks
	 * for itself): a link to another page, the browser's back button, a closed tab. While `dirty`
	 * is true it stops the move and says what leaving costs; confirming goes where the person was
	 * going. A closed tab or an address typed over cannot show our dialog, so the browser asks
	 * in its own words.
	 */
	interface Props {
		dirty: boolean;
	}

	let { dirty }: Props = $props();

	let target = $state<URL | null>(null);
	let leaving = false;
	const text = $derived(leaveDialog());

	beforeNavigate(({ cancel, from, to, type }) => {
		if (!dirty || leaving) return;
		// Staying on this page (the link to where we already are) loses nothing: leave it alone.
		if (type !== 'leave' && from && to && from.url.pathname === to.url.pathname) return;
		cancel();
		if (type !== 'leave' && to) target = to.url;
	});

	async function leave() {
		const url = target;
		target = null;
		leaving = true;
		// Whatever happens, the next move is asked about again unless this page is gone.
		try {
			if (url) await goto(url);
		} finally {
			leaving = false;
		}
	}
</script>

<ConfirmDialog
	open={target !== null}
	title={text.title}
	body={text.body}
	confirmLabel={text.confirm}
	cancelLabel={text.keep}
	tone="danger"
	onconfirm={leave}
	oncancel={() => (target = null)}
/>
