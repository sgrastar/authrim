<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeLaunchers } from '#lib/api/fake/launchers-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import LauncherList from './LauncherList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Launchers',
		component: LauncherList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Launchers (`/api/admin/launchers`): the tiles of the account page, in the order it shows them. The arrows save a new order at once; a row opens the launcher’s page, where it is edited; **Create launcher** opens the same page for a new one. A new environment has none, and the page says so.'
				}
			}
		}
	});
	const hrefOf = (id: string) => `/admin/customization/launchers/${id}`;
	const onopen = fn();
</script>

<Story name="Saved launchers">
	{#snippet template()}
		<LauncherList client={createFakeLaunchers()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<!-- A new environment: nothing yet, and the way to make the first. -->
<Story
	name="None yet"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.list.empty'));
		const links = canvas.getAllByRole('link', { name: t('ln.list.create') });
		for (const link of links) await expect(link).toHaveAttribute('href', hrefOf('new'));
		await expect(canvas.queryByRole('columnheader', { name: t('ln.list.order') })).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherList client={createFakeLaunchers([])} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="Moving one down saves the order"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const down = await canvas.findByRole('button', {
			name: t('ln.list.moveDown', { name: 'Documentation' })
		});
		await userEvent.click(down);
		await waitFor(() => {
			const names = canvas
				.getAllByRole('row')
				.slice(1)
				.map((row) => row.textContent ?? '');
			expect(names[0]).toContain('Student portal');
			expect(names[1]).toContain('Documentation');
		});
		// The arrow pressed keeps the focus, on the row's new place.
		await waitFor(() =>
			expect(
				canvas.getByRole('button', { name: t('ln.list.moveDown', { name: 'Documentation' }) })
			).toHaveFocus()
		);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<LauncherList client={createFakeLaunchers()} canWrite {hrefOf} {onopen} />
		<Toaster />
	{/snippet}
</Story>

<Story
	name="Opening a row"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByText('Learning portal'));
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('ln-lms'));
	}}
>
	{#snippet template()}
		<LauncherList client={createFakeLaunchers()} canWrite {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Documentation');
		await expect(canvas.queryByRole('link', { name: t('ln.list.create') })).toBeNull();
		await expect(
			canvas.queryByRole('button', { name: t('ln.list.moveDown', { name: 'Documentation' }) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<LauncherList client={createFakeLaunchers()} canWrite={false} {hrefOf} {onopen} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<LauncherList
			client={createFakeLaunchers(undefined, { delay: 60_000 })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ln.list.loadFailed'));
		await expect(canvas.getByRole('button', { name: t('common.retry') })).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<LauncherList
			client={createFakeLaunchers(undefined, { failLoad: true })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="No access">
	{#snippet template()}
		<LauncherList
			client={createFakeLaunchers(undefined, { forbidden: true })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>
