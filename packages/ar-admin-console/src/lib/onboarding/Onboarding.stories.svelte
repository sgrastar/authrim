<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ChecklistHarness from './ChecklistHarness.svelte';
	import GuideHarness from './GuideHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Overview/First steps',
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The first-steps checklist on the overview, and the guide each item starts. The checklist lists what to try in a new environment; a finished item is checked, and the progress is the signed-in admin’s, per tenant, kept by the Admin API (`/api/admin/me/onboarding`). A guide (Driver.js) goes to the item’s page and points at where to work, one step at a time, across pages; the page stays usable, and steps that wait for the person say what to do in a box of their own. The popover is dressed in the console’s tokens (`guide.css`): the card surface, the type scale, the console’s buttons, no accent stripe. Items and steps are defined in one file, `src/lib/onboarding/checklist.ts`.'
				}
			}
		}
	});

	const popover = (canvasElement: HTMLElement) =>
		waitFor(() => {
			const found = canvasElement.ownerDocument.querySelector<HTMLElement>(
				'.driver-popover.console-guide'
			);
			if (!found) throw new Error('no popover');
			return found;
		});
</script>

<Story
	name="Checklist: nothing done"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ob.progress', { done: 0, total: 4 }));
		// Every item has a guide and can be checked by hand; the first one is the one to do next.
		await expect(canvas.getAllByRole('listitem')).toHaveLength(4);
		const mark = canvas.getByRole('button', {
			name: t('ob.markDoneNamed', { name: t('ob.signIn.title') })
		});
		await userEvent.click(mark);
		await canvas.findByText(t('ob.progress', { done: 1, total: 4 }));
		await canvas.findByRole('button', {
			name: t('ob.againNamed', { name: t('ob.signIn.title') })
		});
	}}
>
	{#snippet template()}
		<ChecklistHarness />
	{/snippet}
</Story>

<Story name="Checklist: in progress, a guide running">
	{#snippet template()}
		<ChecklistHarness completed={['sign-in']} activeItemId="theme" />
	{/snippet}
</Story>

<Story
	name="Checklist: all done"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ob.allDone'));
	}}
>
	{#snippet template()}
		<ChecklistHarness completed={['sign-in', 'theme', 'schema', 'screens']} />
	{/snippet}
</Story>

<Story
	name="Checklist: progress not loaded"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ob.loadFailed'));
	}}
>
	{#snippet template()}
		<ChecklistHarness fail />
	{/snippet}
</Story>

<Story
	name="Guide: a step with Next"
	play={async ({ canvasElement }) => {
		const pop = await popover(canvasElement);
		await expect(pop).toHaveTextContent(t('ob.theme.s2.body'));
		await within(pop).findByRole('button', { name: t('ob.next') });
	}}
>
	{#snippet template()}
		<GuideHarness startAt={1} />
	{/snippet}
</Story>

<Story
	name="Guide: a step that waits for the person"
	play={async ({ canvasElement }) => {
		const pop = await popover(canvasElement);
		await expect(pop).toHaveTextContent(t('ob.theme.s5.action'));
		// It moves on when the person does it, so there is no Next.
		await expect(within(pop).queryByRole('button', { name: t('ob.next') })).toBeNull();
	}}
>
	{#snippet template()}
		<GuideHarness startAt={4} />
	{/snippet}
</Story>

<Story
	name="Guide: from the checklist to done, across pages"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const text = async (key: Parameters<typeof t>[0]) =>
			waitFor(async () => expect(await popover(canvasElement)).toHaveTextContent(t(key)));
		const next = async () =>
			userEvent.click(
				within(await popover(canvasElement)).getByRole('button', { name: t('ob.next') })
			);

		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('ob.startNamed', { name: t('ob.theme.title') })
			})
		);
		// The guide went to the themes page and waits for a theme to be opened.
		await text('ob.theme.s1.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.list.create') }));
		await text('ob.theme.s2.body');
		await next();
		await text('ob.theme.s3.body');
		await next();
		await text('ob.theme.s4.action');
		await userEvent.click(canvas.getByRole('tab', { name: 'Images' }));
		await text('ob.theme.s5.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.bg.browse') }));
		await text('ob.theme.s6.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		// Saved: the item is checked, and the guide offers the way back to the list.
		await text('ob.done.title');
		await userEvent.click(
			within(await popover(canvasElement)).getByRole('button', { name: t('ob.done.back') })
		);
		await canvas.findByText(t('ob.progress', { done: 1, total: 1 }));
	}}
>
	{#snippet template()}
		<GuideHarness />
	{/snippet}
</Story>
