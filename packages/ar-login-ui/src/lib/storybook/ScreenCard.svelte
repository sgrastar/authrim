<script lang="ts">
	/** The container a screen sits in on the login and signup routes. */
	import type { Snippet } from 'svelte';
	import Card from '$lib/components/Card.svelte';

	let { children, wide = false }: { children: Snippet; wide?: boolean } = $props();
</script>

<div class="auth-main">
	<div class="auth-container" class:auth-container--wide={wide}>
		<Card class="mb-6">
			<div class="runtime-screen-step mb-4">
				{@render children()}
			</div>
		</Card>
	</div>
</div>
