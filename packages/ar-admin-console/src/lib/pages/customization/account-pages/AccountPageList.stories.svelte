<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { fakeAccountPages, sampleDocument } from '#lib/api/fake/account-pages-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AccountPageList from './AccountPageList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Account page/List',
		component: AccountPageList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Account page (`/admin/customization/account-page`; the pages are kept in the Login UI settings, `login-ui.account_pages`): the pages the tenant has for the signed-in user’s account page. Right after setup there is one, made from the preset (it is stored with the first change). A page is opened to be built; the list creates, duplicates and deletes pages and chooses the one users see (a published page). The page users see and the last page cannot be deleted. Changing needs `admin:settings:write`.'
				}
			}
		}
	});

	const onopen = fn();
</script>

<Story
	name="Right after setup"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Authrim standard');
		await expect(canvas.getByText(t('ap.preset'))).toBeVisible();
		await expect(canvas.getByText(t('ap.state.unpublished'))).toBeVisible();
		await expect(canvas.getByRole('button', { name: t('ap.new') })).toBeVisible();
	}}
>
	{#snippet template()}
		<AccountPageList client={fakeAccountPages({ delay: 80 })} canWrite {onopen} />
	{/snippet}
</Story>

<Story
	name="Pages in each state"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Employee portal');
		await expect(canvas.getByText(t('ap.inUse'))).toBeVisible();
		await expect(canvas.getByText(t('ap.state.published'))).toBeVisible();
		await expect(canvas.getByText(t('ap.state.changed'))).toBeVisible();
		await expect(canvas.getByText(t('ap.state.unpublished'))).toBeVisible();
	}}
>
	{#snippet template()}
		<AccountPageList client={fakeAccountPages({ document: sampleDocument() })} canWrite {onopen} />
	{/snippet}
</Story>

<Story
	name="Create a page"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		onopen.mockClear();
		toast.dismissAll();
		await canvas.findByText('Authrim standard');
		await userEvent.click(canvas.getByRole('button', { name: t('ap.new') }));
		await within(canvasElement.ownerDocument.body).findByText(t('ap.toast.created'));
		await expect(onopen).toHaveBeenCalledTimes(1);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageList client={fakeAccountPages()} canWrite {onopen} />
	{/snippet}
</Story>

<Story
	name="Delete a page"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText('Trial page');
		// The page users see cannot be deleted.
		await userEvent.click(
			canvas.getByRole('button', { name: t('ap.col.actionsFor', { name: 'Employee portal' }) })
		);
		await expect(await body.findByRole('menuitem', { name: t('ap.action.delete') })).toBeDisabled();
		await userEvent.keyboard('{Escape}');
		await userEvent.click(
			canvas.getByRole('button', { name: t('ap.col.actionsFor', { name: 'Trial page' }) })
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('ap.action.delete') }));
		await body.findByText(t('ap.delete.title', { name: 'Trial page' }));
		await userEvent.click(body.getByRole('button', { name: t('ap.delete.confirm') }));
		await body.findByText(t('ap.toast.deleted'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageList client={fakeAccountPages({ document: sampleDocument() })} canWrite {onopen} />
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Employee portal');
		await expect(canvas.queryByRole('button', { name: t('ap.new') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: /Actions for/ })).toBeNull();
	}}
>
	{#snippet template()}
		<AccountPageList
			client={fakeAccountPages({ document: sampleDocument() })}
			canWrite={false}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ap.noAccess'));
	}}
>
	{#snippet template()}
		<AccountPageList
			client={fakeAccountPages({ failOn: { load: 403 } })}
			canWrite={false}
			{onopen}
		/>
	{/snippet}
</Story>
