<script lang="ts">
	import Pagination from '../patterns/Pagination.svelte';

	/** Storybook demo: controlled paging over a fixed total. */
	interface Props {
		total?: number;
		pageSizes?: readonly number[];
		initialPage?: number;
	}

	let { total = 1234, pageSizes, initialPage = 1 }: Props = $props();
	// Seeded from the story args; the pager owns it afterwards.
	let page = $derived(initialPage);
	let pageSize = $state(20);
</script>

<div
	style="max-width:880px;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--bg-card)"
>
	<Pagination bind:page bind:pageSize {total} {pageSizes} />
</div>
