<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { FAKE_BANNER_IMAGE, FAKE_LAUNCHER_ICONS } from '#lib/api/fake/launchers-fake.js';
	import { sampleTenants } from '#lib/api/fake/tenants-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import TenantPickerDialog from '#lib/pages/tenants/TenantPickerDialog.svelte';
	import LauncherIcon from './LauncherIcon.svelte';
	import LauncherIconPicker from './LauncherIconPicker.svelte';
	import LauncherPreview from './LauncherPreview.svelte';
	import LauncherSharingFields from './LauncherSharingFields.svelte';
	import LauncherTile from './LauncherTile.svelte';
	import { newLauncherValue } from './launcher-model';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Launcher parts',
		component: LauncherTile,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The pieces of a launcher’s page. **LauncherIcon**: the rounded square in the launcher’s own colours (the admin’s, stored with it, not the theme’s) with its Phosphor icon or picture. **LauncherTile**: the tile as the account page draws it. **LauncherPreview**: the tile on the account page’s eight columns, as wide as it is set. **LauncherIconPicker**: the allowed icons as one radio group. **LauncherSharingFields**: whom a platform launcher is shared with (every tenant, or tenants chosen in **TenantPickerDialog**, a selectable table of the tenants) and whether tenants may change it.'
				}
			}
		}
	});

	const loadTenants = async () => sampleTenants();
	const sharingValue = () => ({
		...newLauncherValue(),
		shareMode: 'selected' as const,
		tenantIds: ['acme', 'globex']
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

<script lang="ts">
	let sharing = $state(sharingValue());
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

<!-- A picture across the tile's width (its height follows the picture); the icon and the name
     can be hidden, the name staying the tile's accessible name. -->
<Story
	name="Tiles with a picture"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The hidden name is still there for screen readers.
		await expect(canvas.getAllByText('Library')).toHaveLength(2);
		const pictures = canvasElement.querySelectorAll('.launcher-tile__image');
		await expect(pictures).toHaveLength(2);
	}}
>
	{#snippet template()}
		<div style="display: grid; grid-template-columns: repeat(2, 260px); gap: 12px">
			<LauncherTile
				{...tile}
				name="Library"
				backgroundImage={FAKE_BANNER_IMAGE}
				hideIcon
				hideName
			/>
			<LauncherTile {...tile} name="Library" backgroundImage={FAKE_BANNER_IMAGE} hideIcon />
		</div>
	{/snippet}
</Story>

<!-- The two share choices exclude each other; chosen tenants are counted, and changes by tenants
     are allowed by default. -->
<Story
	name="Sharing, chosen tenants"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const all = canvas.getByRole('checkbox', { name: t('ln.sharing.all') });
		const chosen = canvas.getByRole('checkbox', { name: t('ln.sharing.selected') });
		await expect(chosen).toBeChecked();
		await expect(canvas.getByText(t('ln.sharing.count', { n: 2 }))).toBeInTheDocument();
		await userEvent.click(all);
		await expect(all).toBeChecked();
		await expect(chosen).not.toBeChecked();
		// Its description is read with it: the name starts with the checkbox's own label.
		const change = canvas
			.getAllByRole('checkbox')
			.find((box) => box.closest('label')?.textContent?.includes(t('ln.sharing.changeAllowed')));
		await expect(change).toBeChecked();
	}}
>
	{#snippet template()}
		<div style="max-width: 760px">
			<LauncherSharingFields bind:value={sharing} {loadTenants} errors={{}} />
		</div>
	{/snippet}
</Story>

<!-- The tenant picker: a table with a checkbox per tenant, a search and sorting; deleted
     tenants are not offered. -->
<Story
	name="Tenant picker"
	play={async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await body.findByRole('checkbox', { name: t('table.selectRow', { name: 'Acme Corporation' }) });
		await expect(
			body.getByRole('button', { name: t('tn.picker.apply', { n: 1 }) })
		).toBeInTheDocument();
		await userEvent.click(
			body.getByRole('checkbox', { name: t('table.selectRow', { name: 'Globex' }) })
		);
		await expect(
			body.getByRole('button', { name: t('tn.picker.apply', { n: 2 }) })
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<TenantPickerDialog
			open
			title={t('ln.sharing.pickTitle')}
			description={t('ln.sharing.pickBody')}
			selected={['acme']}
			{loadTenants}
			onapply={() => {}}
			oncancel={() => {}}
		/>
	{/snippet}
</Story>
