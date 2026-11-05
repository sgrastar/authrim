<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeNoticeDelivery } from '#lib/api/fake/notice-delivery-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import NoticeEmail from './NoticeEmail.svelte';

	const { Story } = defineMeta({
		title: 'Pages/My account/Notice emails',
		component: NoticeEmail,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'My account → Notice emails: whether the notices addressed to this admin are also emailed to the address of the account, and from which severity. The header always shows every notice. Built on `/api/admin/me/notice-preferences` (human sessions only); the stories use an in-memory API with the same rules.'
				}
			}
		}
	});
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('checkbox', { name: t('nt.mail.enabled.text') });
		await canvas.findByRole('combobox', { name: t('nt.mail.minSeverity') });
	}}
>
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery()} />
	{/snippet}
</Story>

<Story
	name="Turned off"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const select = await canvas.findByRole('combobox', { name: t('nt.mail.minSeverity') });
		await expect(select).toBeDisabled();
	}}
>
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery({ preferences: { email_enabled: false } })} />
	{/snippet}
</Story>

<Story
	name="Change and save"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const select = await canvas.findByRole('combobox', { name: t('nt.mail.minSeverity') });
		const save = canvas.getByRole('button', { name: t('nt.mail.save') });
		await expect(save).toBeDisabled();
		await userEvent.selectOptions(select, 'info');
		await expect(save).toBeEnabled();
		await userEvent.click(save);
		await waitFor(() => expect(save).toBeDisabled());
	}}
>
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery()} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery({ delay: 60_000 })} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('nt.mail.loadFailed'));
		await canvas.findByRole('button', { name: t('common.retry') });
	}}
>
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery({ fail: 500 })} />
	{/snippet}
</Story>

<Story
	name="Signed in as an app"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.mail.noAccess'));
	}}
>
	{#snippet template()}
		<NoticeEmail client={createFakeNoticeDelivery({ fail: 403 })} />
	{/snippet}
</Story>
