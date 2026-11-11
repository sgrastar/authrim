<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { FAKE_LAUNCHER_ICONS } from '#lib/api/fake/launchers-fake.js';
	import LauncherIcon from './LauncherIcon.svelte';
	import LauncherIconPicker from './LauncherIconPicker.svelte';
	import LauncherPreview from './LauncherPreview.svelte';
	import LauncherTile from './LauncherTile.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Launcher parts',
		component: LauncherTile,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The pieces of a launcher’s page. **LauncherIcon**: the rounded square in the launcher’s own colours (the admin’s, stored with it, not the theme’s) with its Phosphor icon or picture. **LauncherTile**: the tile as the account page draws it. **LauncherPreview**: the tile on the account page’s eight columns, as wide as it is set. **LauncherIconPicker**: the allowed icons as one radio group.'
				}
			}
		}
	});

	const tile = {
		name: 'Documentation',
		description: 'Guides and how-tos for everyday tasks.',
		category: 'Knowledge',
		iconType: 'phosphor' as const,
		iconValue: 'book-open',
		iconColor: '#ffffff',
		background: '#2563eb',
		openInNewTab: true,
		allowFavorite: true
	};
</script>

<Story name="Tile">
	{#snippet template()}
		<div style="max-width: 260px">
			<LauncherTile {...tile} />
		</div>
	{/snippet}
</Story>

<Story name="Tile, legacy and in place">
	{#snippet template()}
		<div style="max-width: 260px">
			<LauncherTile
				{...tile}
				name="Learning portal"
				iconValue="student"
				background="#7c3aed"
				openInNewTab={false}
				allowFavorite={false}
				legacy
			/>
		</div>
	{/snippet}
</Story>

<!-- A tile in its own colour: the text turns black or white, whichever reads on it. -->
<Story name="Tiles in their own colour">
	{#snippet template()}
		<div style="display: grid; grid-template-columns: repeat(2, 240px); gap: 12px">
			<LauncherTile {...tile} tileBackground="#fde68a" />
			<LauncherTile {...tile} tileBackground="#1e3a8a" iconColor="#1e3a8a" background="#ffffff" />
		</div>
	{/snippet}
</Story>

<Story name="Icons in sizes">
	{#snippet template()}
		<div style="display: flex; gap: 12px; align-items: center">
			<LauncherIcon
				iconType="phosphor"
				value="rocket-launch"
				background="#0f766e"
				color="#ffffff"
				size="sm"
			/>
			<LauncherIcon
				iconType="phosphor"
				value="rocket-launch"
				background="#0f766e"
				color="#ffffff"
			/>
			<LauncherIcon
				iconType="phosphor"
				value="rocket-launch"
				background="#0f766e"
				color="#ffffff"
				size="lg"
			/>
			<!-- An icon the console cannot draw falls back to the generic app icon. -->
			<LauncherIcon iconType="phosphor" value="not-an-icon" background="#334155" color="#ffffff" />
		</div>
	{/snippet}
</Story>

<Story name="Preview, three columns wide">
	{#snippet template()}
		<LauncherPreview {...tile} width={3} />
	{/snippet}
</Story>

<Story
	name="Icon picker"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const chosen = canvas.getByRole('radio', { name: 'rocket-launch' });
		await expect(chosen).toBeChecked();
		await userEvent.click(canvas.getByRole('radio', { name: 'globe' }).closest('label')!);
		await expect(canvas.getByRole('radio', { name: 'globe' })).toBeChecked();
	}}
>
	{#snippet template()}
		<div style="max-width: 520px">
			<LauncherIconPicker
				label="Icon"
				icons={FAKE_LAUNCHER_ICONS}
				value="rocket-launch"
				background="#2563eb"
				color="#ffffff"
			/>
		</div>
	{/snippet}
</Story>
