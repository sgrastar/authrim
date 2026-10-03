<script lang="ts">
	/** The same page under several settings at once, each in a fixed box with its caption. */
	import type { LoginUIOverrides } from './config';
	import LoginUIFrame from './LoginUIFrame.svelte';
	import PageSample from './PageSample.svelte';
	import type { Scheme, ThemeTemplate } from './globals.svelte';

	export type GalleryCell = {
		label: string;
		theme?: ThemeTemplate;
		scheme?: Scheme;
		variant?: string;
		ui?: LoginUIOverrides;
		kind?: 'login' | 'signup';
		client?: boolean;
	};

	type Props = { cells: GalleryCell[]; columns?: number; height?: number };

	let { cells, columns = 2, height = 560 }: Props = $props();
</script>

<div class="sb-gallery" style:--sb-gallery-columns={columns}>
	{#each cells as cell (cell.label)}
		<figure>
			<figcaption>{cell.label}</figcaption>
			<LoginUIFrame
				fit="cell"
				{height}
				theme={cell.theme}
				scheme={cell.scheme}
				variant={cell.variant}
				ui={cell.ui}
			>
				<PageSample kind={cell.kind} client={cell.client} />
			</LoginUIFrame>
		</figure>
	{/each}
</div>

<style>
	.sb-gallery {
		display: grid;
		grid-template-columns: repeat(var(--sb-gallery-columns), minmax(0, 1fr));
		gap: 20px;
		font-family: system-ui, sans-serif;
	}

	figure {
		margin: 0;
	}

	figcaption {
		margin: 0 0 6px;
		font-size: 12px;
		font-weight: 600;
		color: #475569;
	}

	@media (max-width: 900px) {
		.sb-gallery {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
