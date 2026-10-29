<script lang="ts">
	import type { Snippet } from 'svelte';
	import { provideRowStack } from './row-stack';

	/**
	 * Form rows (`TextRow`, `SelectRow`, `CheckRow`…) one under another inside a box. A page never
	 * spaces rows itself, and never with a token that is not defined: an undefined one collapses to
	 * nothing, and the rows touch.
	 *
	 * - default: a field gap (`--space-field`, 16px) apart, without lines. For the fields of one
	 *   thing being made or edited, in a dialog or a short form.
	 * - `ruled`: divided by a line, each row with its own vertical space, as in the settings pages.
	 *   For a box of independent settings saved with the page. The rows inside read it themselves.
	 *
	 * A form with a Save button of its own is a `Form`, which spaces its fields the same way.
	 */
	interface Props {
		ruled?: boolean;
		children: Snippet;
	}

	let { ruled = false, children }: Props = $props();

	provideRowStack({
		get ruled() {
			return ruled;
		}
	});
</script>

<div class="row-stack" class:row-stack--ruled={ruled}>{@render children()}</div>

<style>
	.row-stack {
		display: grid;
		gap: var(--space-field);
	}

	/* The rows bring their own space and lines; what is not a row sits apart the same way. */
	.row-stack--ruled {
		gap: 0;
	}

	.row-stack--ruled > :global(:not(.field-row):not(:first-child)) {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border-subtle);
	}
</style>
