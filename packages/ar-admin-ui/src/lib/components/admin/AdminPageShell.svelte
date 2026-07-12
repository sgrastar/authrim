<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
		width?: 'default' | 'narrow';
	}

	let { children, width = 'default' }: Props = $props();
</script>

<div class="admin-page-shell" class:admin-page-shell--narrow={width === 'narrow'}>
	{@render children()}
</div>

<style>
	.admin-page-shell {
		width: 100%;
		min-width: 0;
	}

	.admin-page-shell--narrow {
		max-width: 760px;
	}
</style>
