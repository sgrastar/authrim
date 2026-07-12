<script lang="ts">
	interface Props {
		html: string;
	}

	let { html }: Props = $props();
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -->
{@html html}
