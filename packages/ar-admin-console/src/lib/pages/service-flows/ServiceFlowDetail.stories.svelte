<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import type { ComponentProps } from 'svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import AddConnection from './AddConnection.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Service flow detail',
		component: AddConnection,
		// UI prototype: dummy copy and dummy results, not connected to any API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A connection’s service flow: the hub of its settings, and the screen the Add connection wizard hands over to. The wizard only helped with the first input, so it opens on the **overview**: what was entered and what is still to do. On the left the parts of the flow, top to bottom (the other side of the connection at one end, Authrim’s own steps between, each with its settings and how far it has got); choosing one opens that setting on the right. The flow can grow: the “+” between steps adds an optional one (consent, an extra sign-in) and its × takes it away. The stories open the detail directly, with what the wizard leaves behind (“after the wizard”) or with everything set.'
				}
			}
		}
	});

	const inFlow = (root: HTMLElement, name: RegExp | string) =>
		within(root.querySelector<HTMLElement>('.detail__flow')!).getByRole('button', { name });
	/** The page header, where the connection's own status is (the flow shows its steps' too). */
	const inHeader = (root: HTMLElement) => within(root.querySelector<HTMLElement>('.page-head')!);
	/** The panel on the right, where the back-to-overview button is. */
	const inPanel = (root: HTMLElement) => within(root.querySelector<HTMLElement>('.detail__panel')!);
</script>

{#snippet frame(args: ComponentProps<typeof AddConnection>)}
	<Page>
		<AddConnection {...args} />
	</Page>
{/snippet}

<!-- Right after the wizard: what it did not ask is still to do, and the overview says so. -->
<Story
	name="RP, right after the wizard"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument();
		// What was entered, with what was not entered said so.
		const entered = within(
			canvas.getByRole('heading', { name: 'What you entered' }).parentElement!
		);
		await expect(entered.getByText('Employee portal')).toBeInTheDocument();
		// The redirect URIs and the mapping set are both unset: nothing is filled in on its own.
		await expect(entered.getAllByText('Not set')).toHaveLength(2);
		// What is still to do, as a list that leads to each setting.
		const todo = within(canvas.getByRole('heading', { name: 'Still to do' }).parentElement!);
		await expect(todo.getByText('Required')).toBeInTheDocument();
		// The list leads to the setting. It is not a step of the flow: it is in the general
		// settings above the overview, and focus goes to it.
		await userEvent.click(todo.getByRole('button', { name: 'Redirect URIs' }));
		await waitFor(() =>
			expect(canvasElement.querySelector('[data-part="rp-redirect"]')).toContainElement(
				canvasElement.ownerDocument.activeElement as HTMLElement
			)
		);
		await expect(canvas.getByRole('heading', { name: 'General settings' })).toBeInTheDocument();
		await expect(
			within(canvasElement.querySelector<HTMLElement>('.detail__flow')!).queryByRole('button', {
				name: /^Redirect URIs/
			})
		).toBeNull();
		// The steps of the flow are what Authrim does with the people who pass through.
		await expect(inFlow(canvasElement, /^User information.*Configured/)).toBeInTheDocument();
		// Not ready: activating says what is missing and waits.
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await expect(canvas.getByText(/Still required: Redirect URIs/)).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: 'Activate' })).toBeDisabled();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="SP, right after the wizard" args={{ prefill: 'sp', review: true }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A provider asked nothing in the wizard: the overview leads with its details. -->
<Story
	name="OP, right after the wizard"
	args={{ prefill: 'op', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const todo = within(canvas.getByRole('heading', { name: 'Still to do' }).parentElement!);
		const first = todo.getAllByRole('button')[0];
		await expect(first).toHaveTextContent('The provider’s details');
		await expect(canvas.getByRole('heading', { name: 'General settings' })).toBeInTheDocument();
		await expect(canvas.getByText('Accounts')).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^Matching people.*Configured/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="IdP, right after the wizard" args={{ prefill: 'idp', review: true }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="RP, everything set"
	args={{ prefill: 'rp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(/Everything is set/)).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await expect(canvas.getByRole('button', { name: 'Activate' })).toBeEnabled();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="SP, everything set" args={{ prefill: 'sp', filled: 'complete', review: true }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="OP, everything set" args={{ prefill: 'op', filled: 'complete', review: true }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="IdP, everything set" args={{ prefill: 'idp', filled: 'complete', review: true }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The flow is the hub: each of its settings opens its own screen on the right. -->
<Story
	name="Every setting opens from the flow"
	args={{ prefill: 'rp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// What the other side is sits at the top of the settings, not in the flow.
		for (const label of ['App details', 'Redirect URIs', 'Sign-in method']) {
			await expect(canvas.getByRole('heading', { name: label, level: 3 })).toBeInTheDocument();
		}
		for (const label of ['User information']) {
			await userEvent.click(inFlow(canvasElement, new RegExp(`^${label}`)));
			await expect(canvas.getByRole('heading', { name: label, level: 2 })).toBeInTheDocument();
		}
		// The end of the flow that is the connection itself leads back to the overview.
		await userEvent.click(inFlow(canvasElement, 'Overview'));
		await expect(canvas.getByRole('heading', { name: 'Overview', level: 2 })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The flow can grow: the "+" adds a processing step of the earlier service-flow mock, the × takes it away. -->
<Story
	name="Adding a step with the +"
	args={{ prefill: 'rp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByRole('button', { name: /^Consent statements/ })).toBeNull();
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[1]);
		// The first "+" offers the sign-up flow (see the story below); the next one the processing steps.
		// An app can have a mapping, consent and a role assignment; it has none of them to start with.
		await expect(await canvas.findByRole('button', { name: 'Mapping' })).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: 'Role assignment' })).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: 'Consent' }));
		// The new step opens on its first setting, which has two: statements and policies.
		await expect(
			await canvas.findByRole('heading', { name: 'Consent statements', level: 2 })
		).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^Consent policies.*Not set yet/)).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('checkbox', { name: 'Terms of use (v3)' }));
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Consent statements.*Configured/)).toBeInTheDocument()
		);
		// It shows in what was entered, then goes again with its ×.
		await userEvent.click(inPanel(canvasElement).getByRole('button', { name: 'Overview' }));
		await expect(canvas.getByText('Terms of use (v3)')).toBeInTheDocument();
		await userEvent.click(
			canvas.getByRole('button', { name: t('flow.remove', { name: 'Consent' }) })
		);
		// The step leaves with an exit animation, so it is gone a moment later.
		await waitFor(
			() => expect(canvas.queryByRole('button', { name: /^Consent statements/ })).toBeNull(),
			{ timeout: 3000 }
		);
		await expect(canvas.queryByText('Terms of use (v3)')).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A connection does not define a sign-up: it chooses one of the tenant's sign-up flows. -->
<Story
	name="Choosing a sign-up flow for an app"
	args={{ prefill: 'rp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.queryByRole('button', { name: /^Sign-up flow to use/ })).toBeNull();
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
		await userEvent.click(await canvas.findByRole('button', { name: 'Sign-up' }));
		await expect(
			await canvas.findByRole('heading', { name: 'Sign-up flow to use', level: 2 })
		).toBeInTheDocument();
		// Added but not chosen: still to do, not required, so the app can still go live.
		await expect(inFlow(canvasElement, /^Sign-up flow to use.*Not set yet/)).toBeInTheDocument();
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Sign-up flow' }),
			'partner-portal'
		);
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Sign-up flow to use.*Configured/)).toBeInTheDocument()
		);
		await userEvent.click(inPanel(canvasElement).getByRole('button', { name: 'Overview' }));
		await expect(canvas.getByText('Partner portal sign-up')).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A service and a SAML provider cannot work without a mapping: it is there from the start and stays. -->
<Story
	name="A service has its mapping from the start"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Nothing about the mapping is preselected: it works with what is chosen, and only that.
		await expect(
			inFlow(canvasElement, /^Input and output schemas.*Required.*Not set yet/)
		).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^Mapping sets.*Required.*Not set yet/)).toBeInTheDocument();
		await expect(
			canvas.queryByRole('button', { name: t('flow.remove', { name: 'Mapping' }) })
		).toBeNull();
		// The schemas and the set are what is still required, and activating waits for them.
		const todo = within(canvas.getByRole('heading', { name: 'Still to do' }).parentElement!);
		await expect(todo.getAllByRole('button')[0]).toHaveTextContent('Input and output schemas');
		await userEvent.click(inFlow(canvasElement, /^Input and output schemas/));
		const input = canvas.getByRole('combobox', { name: 'Input schema' });
		const output = canvas.getByRole('combobox', { name: 'Output schema' });
		// Neither is chosen yet.
		await expect(input).toHaveValue('');
		await expect(output).toHaveValue('');
		await userEvent.selectOptions(input, 'authrim');
		await userEvent.selectOptions(output, 'standard');
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Input and output schemas.*Configured/)).toBeInTheDocument()
		);
		await userEvent.click(inFlow(canvasElement, /^Mapping sets/));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Mapping set' }),
			'tenant-default'
		);
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Mapping sets.*Configured/)).toBeInTheDocument()
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A provider can ask the person for what it did not send. -->
<Story
	name="A provider can ask for what is missing"
	args={{ prefill: 'op', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
		await userEvent.click(await canvas.findByRole('button', { name: 'Additional input' }));
		await expect(
			await canvas.findByRole('heading', { name: 'Fields to ask for', level: 2 })
		).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: 'Add a field' }));
		await userEvent.type(canvas.getByRole('textbox', { name: /Fields to ask for/ }), 'department');
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Fields to ask for.*Configured/)).toBeInTheDocument()
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Which side Authrim is on is said on every connection, in words, not only by the kind's name. -->
<Story
	name="Each connection says what Authrim does for it"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('Authrim signs people in')).toBeInTheDocument();
		await expect(
			canvas.getAllByText('People sign in to this app through Authrim.')
		).not.toHaveLength(0);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="A provider is the other side"
	args={{ prefill: 'op', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('People sign in elsewhere')).toBeInTheDocument();
		// Its issuer is its own and comes with its configuration; it is not shown as missing.
		const entered = within(
			canvas.getByRole('heading', { name: 'What you entered' }).parentElement!
		);
		await expect(entered.getByText('Read from the provider’s configuration')).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- An app is told the tenant's issuer, which is fixed. -->
<Story
	name="An app is given the tenant’s own issuer"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// It is not a step of the flow: a frame of its own below the overview.
		await expect(
			within(canvasElement.querySelector<HTMLElement>('.detail__flow')!).queryByRole('button', {
				name: /^Authrim’s details for the app/
			})
		).toBeNull();
		await expect(
			await canvas.findByRole('heading', { name: 'Authrim’s details for the app', level: 2 })
		).toBeInTheDocument();
		await expect(canvas.getByText('https://acme.authrim.example')).toBeInTheDocument();
		await expect(canvas.getByText(/cannot be changed here/)).toBeInTheDocument();
		// Nothing to type: the issuer is shown, to be copied.
		await expect(canvas.getByRole('button', { name: 'Copy Issuer' })).toBeInTheDocument();
		// Nothing to switch on or record: the values are copied and registered on the app's side.
		const frame = canvas
			.getByRole('heading', { name: 'Authrim’s details for the app', level: 2 })
			.closest('section')!;
		await expect(within(frame as HTMLElement).queryByRole('switch')).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Taking back something required takes the connection out of service. -->
<Story
	name="Undoing a required setting makes it a draft again"
	args={{ prefill: 'sp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await userEvent.click(canvas.getByRole('button', { name: 'Activate' }));
		await expect(
			await inHeader(canvasElement).findByText('Active', { selector: '.badge' })
		).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Mapping sets/));
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Mapping set' }), '');
		// The set is gone, so the connection is a draft again and has to be activated once more.
		await expect(
			await inHeader(canvasElement).findByText('Draft', { selector: '.badge' })
		).toBeInTheDocument();
		await expect(inHeader(canvasElement).queryByText('Active', { selector: '.badge' })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The service flow follows the console's language: here Japanese. -->
<Story
	name="In Japanese"
	args={{ prefill: 'sp', review: true }}
	globals={{ locale: 'ja' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: '概要', level: 2 })).toBeInTheDocument();
		await expect(canvas.getByRole('heading', { name: '入力した内容' })).toBeInTheDocument();
		await expect(canvas.getByText('Authrim でサインイン')).toBeInTheDocument();
		await expect(canvas.getByText('下書き')).toBeInTheDocument();
		// The steps of the flow and their settings, with how far each has got.
		await expect(canvas.getByText('サインイン応答')).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^マッピングセット.*必須.*未設定/)).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^入力と出力のスキーマ/));
		await expect(canvas.getByRole('combobox', { name: '入力スキーマ' })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A passed test belongs to the details it ran with. -->
<Story
	name="Changing the provider takes its test result back"
	args={{ prefill: 'op', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(inFlow(canvasElement, /^Test the connection.*Configured/)).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await userEvent.click(canvas.getByRole('button', { name: 'Activate' }));
		await expect(
			await inHeader(canvasElement).findByText('Active', { selector: '.badge' })
		).toBeInTheDocument();
		// The provider's details are at the top of the settings: back on the overview they are there.
		await userEvent.click(inFlow(canvasElement, 'Overview'));
		const issuer = canvas.getByRole('textbox', { name: 'Issuer address' });
		await userEvent.clear(issuer);
		await userEvent.type(issuer, 'https://login.other.example');
		await userEvent.click(canvas.getByRole('button', { name: 'Read the configuration' }));
		await waitFor(() => expect(canvas.getByText(/What was found/)).toBeInTheDocument());
		// The new provider has not been tested, however well the old one did.
		await expect(inFlow(canvasElement, /^Test the connection.*Not set yet/)).toBeInTheDocument();
		// And it is a draft again until it has been tested and activated once more.
		await expect(
			await inHeader(canvasElement).findByText('Draft', { selector: '.badge' })
		).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Discard puts back what was saved, tested and in service, not a connection that looks edited. -->
<Story
	name="Discard keeps a tested connection in service"
	args={{ prefill: 'op', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = () => canvasElement.querySelector<HTMLElement>('.save-bar')!;
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await userEvent.click(canvas.getByRole('button', { name: 'Activate' }));
		await expect(
			await inHeader(canvasElement).findByText('Active', { selector: '.badge' })
		).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, 'Overview'));
		// An edit of the provider's address takes it out of service in the draft, and raises the bar.
		const issuer = canvas.getByRole('textbox', { name: 'Issuer address' });
		await userEvent.clear(issuer);
		await userEvent.type(issuer, 'https://login.other.example');
		await waitFor(() => expect(bar()).toHaveClass('is-shown'));
		await expect(
			await inHeader(canvasElement).findByText('Draft', { selector: '.badge' })
		).toBeInTheDocument();
		// Discard: back to what was saved, and nothing is left to save.
		await userEvent.click(within(bar()).getByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(bar()).not.toHaveClass('is-shown'));
		await expect(
			await inHeader(canvasElement).findByText('Active', { selector: '.badge' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('textbox', { name: 'Issuer address' })).toHaveValue(
			'https://login.acme.example'
		);
		await expect(inFlow(canvasElement, /^Test the connection.*Configured/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- With changes still unsaved, activating waits for Save: only what is saved goes into service. -->
<Story
	name="Activating waits for Save"
	args={{ prefill: 'rp', filled: 'complete', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button', { name: 'Add redirect URI' })[0]);
		await userEvent.type(
			canvas.getAllByRole('textbox', { name: /Redirect URIs/ }).at(-1)!,
			'https://portal.example.com/second'
		);
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await expect(canvas.getByText(/Save your changes before activating/)).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: 'Activate' })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: 'Save changes' }));
		await waitFor(() => expect(canvas.getByRole('button', { name: 'Activate' })).toBeEnabled());
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>
