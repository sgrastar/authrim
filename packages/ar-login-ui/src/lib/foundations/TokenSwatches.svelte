<script lang="ts">
	/** Lists the CSS variables of the surrounding theme with their computed values. */
	import { onMount } from 'svelte';

	type Props = { tokens: readonly string[]; kind?: 'color' | 'length' };
	let { tokens, kind = 'color' }: Props = $props();

	let root: HTMLElement;
	let values = $state<Record<string, string>>({});

	function read() {
		const style = getComputedStyle(root);
		values = Object.fromEntries(
			tokens.map((token) => [token, style.getPropertyValue(token).trim()])
		);
	}

	onMount(() => {
		read();
		// The theme can change under a mounted story (toolbar), so re-read after attributes change.
		const observer = new MutationObserver(read);
		const boundary = root.closest('.login-ui-theme-boundary');
		if (boundary) observer.observe(boundary, { attributes: true });
		return () => observer.disconnect();
	});
</script>

<div bind:this={root} class="tokens">
	{#each tokens as token (token)}
		<div class="row">
			{#if kind === 'color'}
				<span class="swatch" style:background={`var(${token})`}></span>
			{:else}
				<span class="length" style:border-radius={`var(${token})`}></span>
			{/if}
			<code>{token}</code>
			<small>{values[token] || '(unset)'}</small>
		</div>
	{/each}
</div>

<style>
	.tokens {
		display: grid;
		gap: 6px;
	}

	.row {
		display: grid;
		grid-template-columns: 28px minmax(120px, 190px) minmax(0, 1fr);
		align-items: center;
		gap: 10px;
	}

	.swatch,
	.length {
		width: 28px;
		height: 28px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.length {
		background: var(--primary-light, rgba(128, 128, 128, 0.2));
	}

	code {
		font: 0.75rem/1.3 var(--font-mono);
		color: var(--text-primary);
	}

	small {
		font: 0.6875rem/1.3 var(--font-mono);
		color: var(--text-muted);
		word-break: break-all;
	}
</style>
