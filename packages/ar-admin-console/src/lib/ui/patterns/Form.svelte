<script lang="ts">
	import type { Snippet } from 'svelte';
	import { provideBusy } from '../busy/busy';

	/** Vertical form layout. Pages never space fields themselves. */
	interface Props {
		onsubmit: (event: SubmitEvent) => void;
		/** Accessible name when the form has no visible heading of its own. */
		label?: string;
		/** Saving or submitting: the fields and buttons in the form stop taking input. */
		busy?: boolean;
		children: Snippet;
	}

	let { onsubmit, label, busy = false, children }: Props = $props();

	provideBusy(() => busy);
</script>

<form class="form" aria-label={label} aria-busy={busy || undefined} {onsubmit}>
	{@render children()}
</form>

<style>
	.form {
		display: grid;
		gap: var(--space-field);
	}
</style>
