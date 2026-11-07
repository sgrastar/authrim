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
		/**
		 * Skip the browser's own check of `required` and typed fields, for a form that checks them
		 * itself and shows its own message under each field (the fields keep their "*" marks).
		 */
		novalidate?: boolean;
		children: Snippet;
	}

	let { onsubmit, label, busy = false, novalidate = false, children }: Props = $props();

	provideBusy(() => busy);
</script>

<form class="form" aria-label={label} aria-busy={busy || undefined} {novalidate} {onsubmit}>
	{@render children()}
</form>

<style>
	.form {
		display: grid;
		gap: var(--space-field);
	}
</style>
