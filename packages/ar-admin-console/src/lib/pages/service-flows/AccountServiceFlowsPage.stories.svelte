<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccountServiceFlowsHarness from './AccountServiceFlowsHarness.svelte';
	import { MOCK_CLIENTS, MOCK_SYSTEM_CLIENTS } from '#lib/api/fake/clients-fake.js';
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

<!-- The live page: the tenant's own apps join the preset flows in one table; the clients Authrim registered for itself (Login UI, downstream introspection) are not service flows and are not listed. -->
<Story
	name="Apps join the flows; Authrim's own clients are not listed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const flows = await canvas.findByRole('table', { name: t('sf.mock.connections') });
		await within(flows).findByRole('button', { name: t('sf.mock.open', { name: 'Member app' }) });
		await expect(within(flows).getAllByRole('row')).toHaveLength(1 + 2 + MOCK_CLIENTS.length + 2);
		await expect(canvas.queryByText('Login UI')).toBeNull();
		await expect(canvas.queryByText('Downstream Grant Introspection')).toBeNull();
		await expect(canvas.getAllByRole('table')).toHaveLength(1);
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness
			answer="seeded"
			showConnections
			clients={[...MOCK_CLIENTS, ...MOCK_SYSTEM_CLIENTS]}
		/>{/snippet}
</Story>

<!-- Only Authrim's own clients exist (a tenant just set up): the page holds the two presets and nothing else. -->
<Story
	name="A new tenant: presets only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const flows = await canvas.findByRole('table', { name: t('sf.mock.connections') });
		await within(flows).findByRole('button', {
			name: t('sf.mock.open', { name: 'Standard sign-up' })
		});
		// The header row, sign-up and sign-in: nothing of the tenant's.
		await expect(within(flows).getAllByRole('row')).toHaveLength(3);
		await expect(canvas.getAllByRole('table')).toHaveLength(1);
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness
			answer="seeded"
			showConnections
			clients={MOCK_SYSTEM_CLIENTS}
			samlServiceProviders={[]}
		/>{/snippet}
</Story>

<!-- The flows could not be read but the connections were: they are still listed and open on their own. -->
<Story
	name="Load failed: the connections read are still listed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('af.live.loadFailed'));
		const flows = await canvas.findByRole('table', { name: t('sf.mock.connections') });
		await within(flows).findByRole('button', { name: t('sf.mock.open', { name: 'Member app' }) });
		await expect(within(flows).queryByText('Standard sign-up')).toBeNull();
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="failed" showConnections />{/snippet}
</Story>

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

<!-- Consent asked before sign-in completes is saved into the Flow: a consent step before each completion. -->
<Story
	name="Sign-in consent is saved into the Flow"
	play={async ({ canvasElement }) => {
		saves.length = 0;
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('sf.mock.open', { name: 'Authentication-only Login' })
			})
		);
		await userEvent.click(await canvas.findByRole('button', { name: t('flow.add') }));
		await userEvent.click(await canvas.findByRole('button', { name: 'Consent at sign-in' }));
		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('af.consent.add') }),
			'stmt_terms'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('af.consent.add') }));
		await userEvent.click(canvas.getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(saves.length).toBeGreaterThan(0));
		const editor = saves[saves.length - 1].editor as {
			nodes: { id: string; type: string; config?: { statements?: unknown } }[];
		};
		const consent = editor.nodes.filter((node) => node.type === 'consent');
		await expect(consent.length).toBeGreaterThan(0);
		await expect(consent[0].config?.statements).toEqual([
			{ statement_id: 'stmt_terms', required: true }
		]);
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="seeded" {saves} />{/snippet}
</Story>

<!-- A sign-in with no completion step cannot take consent here: the setting is shown disabled and says to use the Flow editor. -->
<Story
	name="Sign-in consent is not available without a completion"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('sf.mock.open', { name: 'Authentication-only Login' })
			})
		);
		await userEvent.click(await canvas.findByRole('button', { name: t('flow.add') }));
		await userEvent.click(await canvas.findByRole('button', { name: 'Consent at sign-in' }));
		await expect(await canvas.findByText(t('af.consent.unavailable'))).toBeInTheDocument();
		await expect(canvas.queryByRole('combobox', { name: t('af.consent.add') })).toBeNull();
	}}
>
	{#snippet template()}<AccountServiceFlowsHarness answer="no-completion" />{/snippet}
</Story>
