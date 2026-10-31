<script lang="ts">
	import type { Snippet } from 'svelte';
	import { provideBusy } from './busy';

	/**
	 * Marks its contents busy while `busy` is true: buttons and choices are disabled, text
	 * fields become read-only (they keep focus and their text stays selectable), links stop
	 * navigating. The control that started the action shows `loading` on its own. Renders no
	 * element, so it never changes the layout.
	 */
	interface Props {
		busy: boolean;
		children: Snippet;
	}

	let { busy, children }: Props = $props();

	provideBusy(() => busy);
</script>

{@render children()}
