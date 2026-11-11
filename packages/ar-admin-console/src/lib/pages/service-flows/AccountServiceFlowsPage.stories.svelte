<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccountServiceFlowsHarness from './AccountServiceFlowsHarness.svelte';
	import AccountServiceFlowsPage from './AccountServiceFlowsPage.svelte';

	const saves: { kind: string; editor: unknown }[] = [];
	const control: { release?: () => void } = {};

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Account service flows',
		component: AccountServiceFlowsPage,
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The first live service-flow page, using the Storybook account-flow mock. The list contains only sign-up and sign-in. Their detail and the add wizard are local UI state; no service-flow API is connected.'
				}
			}
		}
	});
</script>

<Story
	name="Sign-up and sign-in only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const list = canvas.getByRole('table', { name: t('sf.mock.connections') });
		await expect(within(list).getAllByRole('row')).toHaveLength(3);
		await expect(within(list).getByText('Standard sign-up')).toBeInTheDocument();
		await expect(within(list).getByText('Standard sign-in')).toBeInTheDocument();
		await expect(within(list).queryByText('SCIM')).toBeNull();

		await userEvent.click(
			canvas.getByRole('button', { name: t('sf.mock.open', { name: 'Standard sign-up' }) })
		);
		await waitFor(() =>
			expect(canvas.getByRole('heading', { name: 'Standard sign-up', level: 1 })).toBeVisible()
		);
		await waitFor(() =>
			expect(canvas.getByRole('heading', { name: 'General settings' })).toBeVisible()
		);
	}}
></Story>

<Story
	name="Add wizard offers the two account flows"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('sf.wizard.title') }));
		await expect(canvas.getByRole('radio', { name: /^Sign-up/ })).toBeInTheDocument();
		await expect(canvas.getByRole('radio', { name: /^Sign-in/ })).toBeInTheDocument();
		await expect(canvas.queryByRole('radio', { name: /SCIM|CSV|SAML|OpenID Connect/ })).toBeNull();
		await userEvent.click(canvas.getByRole('radio', { name: /^Sign-in/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvasElement.querySelector('.wizard__context')).toHaveTextContent('Sign-in');
		await expect(canvas.getByRole('textbox', { name: /Service flow name/ })).toBeRequired();
	}}
></Story>

<!-- The tenant's Flows cannot be read: nothing is listed to open, so no new Flow is made over the tenant's. -->
<Story
	name="Load failed: nothing to open or save"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('af.live.loadFailed'));
		await expect(canvas.getByRole('button', { name: t('common.retry') })).toBeInTheDocument();
		await expect(canvas.queryByRole('table', { name: t('sf.mock.connections') })).toBeNull();
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="failed" />{/snippet}
</Story>

<!-- The standard sign-in every tenant is given is set here: saving changes only its sign-in step, its branches kept. -->
<Story
	name="The standard sign-in is set and saved in place"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('sf.mock.open', { name: 'Authentication-only Login' })
			})
		);
		await waitFor(() =>
			expect(
				canvas.getByRole('heading', { name: 'Authentication-only Login', level: 1 })
			).toBeVisible()
		);
		await expect(canvas.queryByText(t('af.live.notConsole'))).toBeNull();
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="seeded" {saves} />{/snippet}
</Story>

<!-- A read still on its way when a retry came back is dropped when it answers: the older sign-in never replaces the current one. -->
<Story
	name="A late answer from before a retry is dropped"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('common.retry') }));
		const list = await canvas.findByRole('table', { name: t('sf.mock.connections') });
		await within(list).findByText('Authentication-only Login');
		control.release?.();
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(within(list).getByText('Authentication-only Login')).toBeInTheDocument();
		await expect(within(list).queryByText('Old sign-in')).toBeNull();
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="race" {control} />{/snippet}
</Story>
