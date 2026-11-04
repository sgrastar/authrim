<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeNoticeDelivery } from '#lib/api/fake/notice-delivery-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SlackChannels from './SlackChannels.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Operations/Slack channels',
		component: SlackChannels,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The "Slack channels" card of Operations → Notifications: the Incoming Webhook channels notices are posted to, each with the lowest severity it receives. A webhook URL is typed once and never read back; only its end is shown. Changing needs settings write; the platform’s own channels need platform authority. Built on `/api/admin/notice-channels`; the stories use an in-memory API with the same rules.'
				}
			}
		}
	});

	const body = (canvasElement: HTMLElement) => within(canvasElement.ownerDocument.body);
	/** The URL field: its label also names the "show" output, so pick the input. */
	const urlInput = (dialog: HTMLElement) =>
		within(dialog)
			.getAllByLabelText(/^Webhook URL/)
			.find((element) => element.tagName === 'INPUT')!;
	/** A client that records which channels were sent a test post. */
	const tested: string[] = [];
	const fakeWithTestError = createFakeNoticeDelivery({ testError: 'invalid_webhook' });
	const watched = {
		...fakeWithTestError,
		async testChannel(id: string) {
			tested.push(id);
			return fakeWithTestError.testChannel(id);
		}
	};
	const URL_OK = 'https://hooks.slack.com/services/T000/B000/abcdWXYZ';
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('#ops-alerts');
		await canvas.findByText(/…x4Kq/);
		await expect(canvas.queryByText('#platform-oncall')).toBeNull();
		await canvas.findByRole('button', { name: t('nt.slack.add') });
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery()} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Platform admin"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText('#platform-oncall');
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery({ platform: true })} canWrite platform />
	{/snippet}
</Story>

<Story
	name="Add a channel"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.slack.add') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: /^チャンネルの呼び名|Channel name/ }),
			'#sec'
		);
		await userEvent.type(urlInput(dialog), 'https://example.com/x');
		await userEvent.click(within(dialog).getByRole('button', { name: t('nt.slack.add.submit') }));
		// Not a Slack webhook: refused before it is sent.
		await within(dialog).findByText(t('nt.slack.err.url'));
		await userEvent.clear(urlInput(dialog));
		await userEvent.type(urlInput(dialog), URL_OK);
		await userEvent.click(within(dialog).getByRole('button', { name: t('nt.slack.add.submit') }));
		await waitFor(() => expect(canvas.getByText('#sec')).toBeInTheDocument());
		await canvas.findByText(/…WXYZ/);
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery()} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Platform scope offered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.slack.add') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await within(dialog).findByRole('combobox', { name: t('nt.slack.scope') });
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery({ platform: true })} canWrite platform />
	{/snippet}
</Story>

<Story
	name="Cannot store the URL"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.slack.add') }));
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: /^チャンネルの呼び名|Channel name/ }),
			'#sec'
		);
		await userEvent.type(urlInput(dialog), URL_OK);
		await userEvent.click(within(dialog).getByRole('button', { name: t('nt.slack.add.submit') }));
		await within(dialog).findByText(t('nt.slack.err.unavailable'));
	}}
>
	{#snippet template()}
		<SlackChannels
			client={createFakeNoticeDelivery({ failOn: { createChannel: 503 } })}
			canWrite
			platform={false}
		/>
	{/snippet}
</Story>

<Story
	name="Replace the URL"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: t('nt.slack.actions', { name: '#ops-alerts' }) })
		);
		await userEvent.click(
			await body(canvasElement).findByRole('menuitem', { name: t('nt.slack.action.replace') })
		);
		const dialog = await body(canvasElement).findByRole('dialog');
		await userEvent.type(urlInput(dialog), URL_OK);
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('nt.slack.replace.submit') })
		);
		await canvas.findByText(/…WXYZ/);
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery()} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Pause posting"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: t('nt.slack.actions', { name: '#ops-alerts' }) })
		);
		await userEvent.click(
			await body(canvasElement).findByRole('menuitem', { name: t('nt.slack.action.pause') })
		);
		await waitFor(() => expect(canvas.getAllByText(t('nt.slack.off'))).toHaveLength(2));
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery()} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Delete a channel"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: t('nt.slack.actions', { name: '#ops-alerts' }) })
		);
		await userEvent.click(
			await body(canvasElement).findByRole('menuitem', { name: t('nt.slack.action.delete') })
		);
		const dialog = await body(canvasElement)
			.findByRole('alertdialog')
			.catch(() => body(canvasElement).findByRole('dialog'));
		await userEvent.click(
			within(dialog).getByRole('button', { name: t('nt.slack.action.delete') })
		);
		await waitFor(() => expect(canvas.queryByText('#ops-alerts')).toBeNull());
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery()} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Test post"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', { name: t('nt.slack.actions', { name: '#ops-alerts' }) })
		);
		await userEvent.click(
			await body(canvasElement).findByRole('menuitem', { name: t('nt.slack.action.test') })
		);
		// The toast host is not mounted in Storybook: the call itself is what is checked.
		await waitFor(() => expect(tested).toContain('nch_ops'));
	}}
>
	{#snippet template()}
		<SlackChannels client={watched} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('#ops-alerts');
		await expect(canvas.queryByRole('button', { name: t('nt.slack.add') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: /^操作|Actions/ })).toBeNull();
	}}
>
	{#snippet template()}
		<SlackChannels
			client={createFakeNoticeDelivery({ canWrite: false })}
			canWrite={false}
			platform={false}
		/>
	{/snippet}
</Story>

<Story
	name="No channels"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.slack.empty'));
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery({ channels: [] })} canWrite platform={false} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery({ delay: 60_000 })} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('nt.slack.loadFailed'));
		await canvas.findByRole('button', { name: t('common.retry') });
	}}
>
	{#snippet template()}
		<SlackChannels client={createFakeNoticeDelivery({ fail: 500 })} canWrite platform={false} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.slack.noAccess'));
	}}
>
	{#snippet template()}
		<SlackChannels
			client={createFakeNoticeDelivery({ fail: 403 })}
			canWrite={false}
			platform={false}
		/>
	{/snippet}
</Story>
