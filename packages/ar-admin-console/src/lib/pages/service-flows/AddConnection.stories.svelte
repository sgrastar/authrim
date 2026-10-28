<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import type { ComponentProps } from 'svelte';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import AddConnection from './AddConnection.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Add connection',
		component: AddConnection,
		// UI prototype: dummy copy and dummy results, not connected to any API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Service flows → Add connection. The one place a new app, service or provider starts. It asks where to connect (which way, then what), then only what that kind cannot start without; “Continue to settings” ends the wizard and opens the connection’s service flow (see Service flow detail). All four kinds are here: an OpenID Connect app (RP) and a SAML service (SP) that sign in through Authrim, and an OpenID Connect provider (OP) and a SAML identity provider (IdP) that people sign in through. Everything is dummy: nothing is sent anywhere, “Read the metadata” and “Run the test” only pretend.'
				}
			}
		}
	});

	const next = (canvas: ReturnType<typeof within>) =>
		userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
	const button = (canvas: ReturnType<typeof within>, name: string | RegExp) =>
		canvas.getByRole('button', { name });
	const choose = (canvas: ReturnType<typeof within>, name: RegExp) =>
		userEvent.click(canvas.getByRole('radio', { name }));

	/** A setting in the flow on the left (the overview lists some of the same names). */
	const inFlow = (root: HTMLElement, name: RegExp) =>
		within(root.querySelector<HTMLElement>('.detail__flow')!).getByRole('button', { name });

	const OUT = /^Let an app or service sign in through Authrim/;
	const IN = /^Let people sign in through another provider/;

	/** The two questions, then the kind. */
	async function begin(canvas: ReturnType<typeof within>, way: RegExp, kind: RegExp) {
		await choose(canvas, way);
		await next(canvas);
		await choose(canvas, kind);
		await next(canvas);
	}
</script>

{#snippet frame(args: ComponentProps<typeof AddConnection>)}
	<Page>
		<AddConnection {...args} />
	</Page>
{/snippet}

<Story
	name="Where to connect"
	args={{ oncancel: fn() }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The two ways sit side by side, not one above the other.
		const [first, second] = ['out', 'in'].map((v) =>
			canvasElement.querySelector(`input[value="${v}"]`)!.closest('label')!.getBoundingClientRect()
		);
		await expect(Math.abs(first.top - second.top)).toBeLessThan(2);
		await expect(second.left).toBeGreaterThan(first.right - 1);
		await expect(button(canvas, t('wizard.next'))).toBeDisabled();
		// Nothing is being set up yet, so nothing is named above the step count.
		await expect(canvasElement.querySelector('.wizard__context')).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Each way offers its own two kinds. -->
<Story
	name="What to connect: out"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, OUT);
		await next(canvas);
		await expect(
			canvas.getByRole('radio', { name: /^An app that uses OpenID Connect/ })
		).toBeInTheDocument();
		await expect(
			canvas.getByRole('radio', { name: /^A service that uses SAML/ })
		).toBeInTheDocument();
		await expect(canvas.queryByRole('radio', { name: /^A provider that/ })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="What to connect: in"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, IN);
		await next(canvas);
		await expect(
			canvas.getByRole('radio', { name: /^A provider that uses OpenID Connect/ })
		).toBeInTheDocument();
		await expect(
			canvas.getByRole('radio', { name: /^A provider that uses SAML/ })
		).toBeInTheDocument();
		await expect(canvas.queryByRole('radio', { name: /^An app that/ })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Choosing the kind adds its steps to the list, and they rise into place like the rows of the left navigation. -->
<Story
	name="Steps appear when the kind is chosen"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, OUT);
		await next(canvas);
		await expect(canvasElement.querySelectorAll('.step')).toHaveLength(2);
		await expect(canvasElement.querySelectorAll('.step.is-entering')).toHaveLength(0);
		await choose(canvas, /^An app that uses OpenID Connect/);
		await waitFor(() => expect(canvasElement.querySelectorAll('.step')).toHaveLength(4));
		// Only the two that were not there before rise; the first two stay where they are.
		await expect(canvasElement.querySelectorAll('.step.is-entering')).toHaveLength(2);
		await waitFor(() =>
			expect(canvasElement.querySelectorAll('.step.is-entering')).toHaveLength(0)
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- From the third step on, the protocol and the role are named above the step count. -->
<Story
	name="RP: app details"
	args={{ prefill: 'rp', step: 2 }}
	play={async ({ canvasElement }) => {
		const context = canvasElement.querySelector('.wizard__context')!;
		await expect(context).toHaveTextContent('OpenID Connect (Relying Party)');
		await expect(context.nextElementSibling).toHaveTextContent('Step 3 of 4');
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="RP: sign-in method" args={{ prefill: 'rp', step: 3 }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="SP: the service’s details"
	args={{ prefill: 'sp', step: 2 }}
	play={async ({ canvasElement }) => {
		await expect(canvasElement.querySelector('.wizard__context')).toHaveTextContent(
			'SAML (Service Provider)'
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story name="SP: attributes" args={{ prefill: 'sp', step: 3 }}>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A provider asks nothing more: choosing it is the last step, and the button is Continue to settings. -->
<Story
	name="OP: nothing more to ask"
	args={{ prefill: 'op', step: 1 }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(button(canvas, t('sf.wizard.finish'))).toBeEnabled();
		await expect(canvas.queryByRole('button', { name: t('wizard.next') })).toBeNull();
		await expect(canvasElement.querySelectorAll('.step')).toHaveLength(2);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="IdP: the provider’s details"
	args={{ prefill: 'idp', step: 2 }}
	play={async ({ canvasElement }) => {
		await expect(canvasElement.querySelector('.wizard__context')).toHaveTextContent(
			'SAML (Identity Provider)'
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Leaving with answers in the wizard says what is lost. -->
<Story
	name="Cancel asks before discarding"
	args={{ oncancel: fn() }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await choose(canvas, OUT);
		await userEvent.click(button(canvas, t('common.cancel')));
		const dialog = within(await within(document.body).findByRole('dialog'));
		await expect(dialog.getByText(/will be lost/)).toBeInTheDocument();
		await expect(args.oncancel).not.toHaveBeenCalled();
		// Keep editing: the answers are still there.
		await userEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
		await expect(canvas.getByRole('radio', { name: OUT })).toBeChecked();
		// Discard: the wizard is left.
		await userEvent.click(button(canvas, t('common.cancel')));
		await userEvent.click(
			within(await within(document.body).findByRole('dialog')).getByRole('button', {
				name: 'Discard'
			})
		);
		await expect(args.oncancel).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Cancel with nothing entered"
	args={{ oncancel: fn() }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(button(canvas, t('common.cancel')));
		await expect(args.oncancel).toHaveBeenCalled();
		await expect(within(document.body).queryByRole('dialog')).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A read that was started for an address that has since changed must not count for the new one. -->
<Story
	name="A read for an address that changed is dropped"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await begin(canvas, OUT, /^A service that uses SAML/);
		const address = canvas.getByRole('textbox', { name: 'Metadata address' });
		await userEvent.type(address, 'https://publisher.example/saml/metadata');
		await userEvent.click(button(canvas, 'Read the metadata'));
		// Before the read finishes, the address is changed.
		await userEvent.type(address, '-2');
		await new Promise((resolve) => setTimeout(resolve, 800));
		// The new address was not read, so the step is not complete.
		await expect(canvas.queryByText('What was found')).toBeNull();
		await expect(button(canvas, t('wizard.next'))).toBeDisabled();
		await userEvent.click(button(canvas, 'Read the metadata'));
		await expect(await canvas.findByText('What was found')).toBeInTheDocument();
		await expect(button(canvas, t('wizard.next'))).toBeEnabled();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Whole flows: the wizard from the first question to Continue to settings, which opens the overview of the service flow. -->
<Story
	name="Whole flow: RP"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await begin(canvas, OUT, /^An app that uses OpenID Connect/);
		// Only a name is wanted; the app type is a card, and the redirect URIs are not asked here.
		await expect(canvas.queryByText('Redirect URIs')).toBeNull();
		await expect(button(canvas, t('wizard.next'))).toBeDisabled();
		await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Reading room');
		await choose(canvas, /^Single-page app/);
		await next(canvas);
		// A single-page app cannot keep a secret: only “None” is open.
		await expect(canvas.getByRole('radio', { name: /^None/ })).toBeChecked();
		await expect(
			canvas.getByRole('radio', { name: /^Client secret, in the header/ })
		).toBeDisabled();
		// The last step ends in Continue to settings, not Add.
		await expect(canvas.queryByRole('button', { name: /Add connection/ })).toBeNull();
		await userEvent.click(button(canvas, t('sf.wizard.finish')));
		// The service flow opens on its overview: what was entered, and what is still to do.
		await expect(
			await canvas.findByRole('heading', { name: 'Overview', level: 2 })
		).toBeInTheDocument();
		const title = canvas.getByRole('heading', { name: 'Reading room', level: 1 });
		await expect(title).toBeInTheDocument();
		// The wizard is gone, so focus goes to the title instead of dropping to the page.
		await waitFor(() => expect(title).toHaveFocus());
		await expect(canvas.getByText('Single-page app')).toBeInTheDocument();
		// A setting is reached from the to-do list, or from the flow on the left.
		await userEvent.click(button(canvas, 'Redirect URIs'));
		await expect(
			canvas.getByRole('heading', { name: 'Redirect URIs', level: 2 })
		).toBeInTheDocument();
		await userEvent.click(button(canvas, 'Add redirect URI'));
		await userEvent.type(
			canvas.getByRole('textbox', { name: /Redirect URIs/ }),
			'https://reading.example.com/cb'
		);
		// Now the connection can be activated.
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await waitFor(() => expect(button(canvas, 'Activate')).toBeEnabled());
		await userEvent.click(button(canvas, 'Activate'));
		await expect(await canvas.findByText(/This connection is active/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Whole flow: SP"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await begin(canvas, OUT, /^A service that uses SAML/);
		await userEvent.type(
			canvas.getByRole('textbox', { name: 'Metadata address' }),
			'https://publisher.example/saml/metadata'
		);
		await expect(button(canvas, t('wizard.next'))).toBeDisabled();
		await userEvent.click(button(canvas, 'Read the metadata'));
		await expect(await canvas.findByText('What was found')).toBeInTheDocument();
		await next(canvas);
		// The wizard stops at the attributes: no test, and nothing to give the service yet.
		await expect(canvas.queryByText('Test the connection')).toBeNull();
		await expect(canvas.queryByText('Your details for them')).toBeNull();
		await userEvent.click(button(canvas, t('sf.wizard.finish')));
		await expect(
			await canvas.findByRole('heading', { level: 2, name: 'Overview' })
		).toBeInTheDocument();
		await expect(
			canvas.getByRole('heading', { level: 1, name: 'publisher.example' })
		).toBeInTheDocument();
		// What is left is in the flow: copy values for the service, then run the test.
		await userEvent.click(inFlow(canvasElement, /^Your details for them/));
		await expect(canvas.getAllByRole('button', { name: /^Copy / }).length).toBeGreaterThan(2);
		await userEvent.click(canvas.getByRole('switch', { name: /I have registered these/ }));
		await userEvent.click(inFlow(canvasElement, /^Test the connection/));
		await userEvent.click(button(canvas, 'Run the test'));
		await expect(await canvas.findByRole('list', { name: 'Test results' })).toBeInTheDocument();
		// A service cannot work without a mapping set: it is a setting of the flow from the start.
		await userEvent.click(inFlow(canvasElement, /^Input and output schemas.*Required/));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Input schema' }),
			'authrim'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Output schema' }),
			'standard'
		);
		await userEvent.click(inFlow(canvasElement, /^Mapping sets.*Required/));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Mapping set' }),
			'tenant-default'
		);
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await userEvent.click(button(canvas, 'Activate'));
		await expect(await canvas.findByText(/This connection is active/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Whole flow: OP"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await choose(canvas, IN);
		await next(canvas);
		await choose(canvas, /^A provider that uses OpenID Connect/);
		// Nothing more is asked of a provider: Continue to settings is open as soon as it is chosen.
		await userEvent.click(button(canvas, t('sf.wizard.finish')));
		await expect(
			await canvas.findByRole('heading', { level: 1, name: 'New provider' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
		// Its details, and the rest, are settings of the flow; the first one still required is first in the list.
		await userEvent.click(button(canvas, 'The provider’s details'));
		await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Acme Directory');
		await userEvent.type(
			canvas.getByRole('textbox', { name: 'Issuer address' }),
			'https://login.acme.example'
		);
		await userEvent.click(button(canvas, 'Read the configuration'));
		await expect(await canvas.findByText('What was found')).toBeInTheDocument();
		await userEvent.type(canvas.getByRole('textbox', { name: 'Client ID' }), 'authrim-acme');
		await userEvent.type(canvas.getByLabelText('Client secret', { selector: 'input' }), 'a-secret');
		await expect(
			canvas.getByRole('heading', { level: 1, name: 'Acme Directory' })
		).toBeInTheDocument();
		// Matching people has a sensible choice already; Authrim gives the provider a redirect address.
		await userEvent.click(inFlow(canvasElement, /^Matching people/));
		await expect(canvas.getByRole('radio', { name: /^By verified email/ })).toBeChecked();
		await userEvent.click(inFlow(canvasElement, /^Your details for them/));
		await expect(canvas.getByText('Redirect URI')).toBeInTheDocument();
		// Activating waits for the test.
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await expect(button(canvas, 'Activate')).toBeDisabled();
		await userEvent.click(inFlow(canvasElement, /^Test the connection/));
		await userEvent.click(button(canvas, 'Run the test'));
		await expect(await canvas.findByRole('list', { name: 'Test results' })).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Review and activate/));
		await userEvent.click(button(canvas, 'Activate'));
		await expect(await canvas.findByText(/This connection is active/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Whole flow: IdP"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await begin(canvas, IN, /^A provider that uses SAML/);
		await userEvent.type(canvas.getByRole('textbox', { name: 'Name' }), 'Campus sign-in');
		await userEvent.type(
			canvas.getByRole('textbox', { name: 'Metadata address' }),
			'https://idp.campus.example/saml/metadata'
		);
		await userEvent.click(button(canvas, 'Read the metadata'));
		await expect(await canvas.findByText('What was found')).toBeInTheDocument();
		// The provider's details are the last thing asked: no matching of people, no test.
		await expect(canvas.queryByText('Matching people')).toBeNull();
		await expect(canvas.queryByText('Test the connection')).toBeNull();
		await userEvent.click(button(canvas, t('sf.wizard.finish')));
		await expect(
			await canvas.findByRole('heading', { level: 1, name: 'Campus sign-in' })
		).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Matching people/));
		await expect(canvas.getByRole('radio', { name: /^By verified email/ })).toBeChecked();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<Story
	name="Going back keeps the answers"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await begin(canvas, OUT, /^A service that uses SAML/);
		await userEvent.click(button(canvas, t('wizard.back')));
		await expect(canvas.getByRole('radio', { name: /^A service that uses SAML/ })).toBeChecked();
		// Changing the way drops a kind that does not go with it.
		await userEvent.click(button(canvas, t('wizard.back')));
		await choose(canvas, IN);
		await next(canvas);
		await expect(
			canvas.getByRole('radio', { name: /^A provider that uses SAML/ })
		).not.toBeChecked();
		await expect(canvas.queryByRole('radio', { name: /^A service that uses SAML/ })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The wizard follows the console's language: here Japanese, from the first step to the settings. -->
<Story
	name="In Japanese"
	globals={{ locale: 'ja' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { level: 1, name: '接続を追加' })).toBeInTheDocument();
		await expect(canvas.getAllByText('接続の向き').length).toBeGreaterThan(0);
		await expect(canvas.getAllByText('接続する相手').length).toBeGreaterThan(0);
		await expect(
			canvas.getByText('接続する相手を選ぶと、残りの手順が表示されます。')
		).toBeInTheDocument();
		await choose(canvas, /^アプリやサービスが Authrim でサインインする/);
		await next(canvas);
		await choose(canvas, /^OpenID Connect を使うアプリ/);
		// The kind's own steps appear, in Japanese too.
		await waitFor(() => expect(canvas.getAllByText('アプリの情報').length).toBeGreaterThan(0));
		await expect(canvas.getAllByText('サインイン方法').length).toBeGreaterThan(0);
		await next(canvas);
		await expect(canvasElement.querySelector('.wizard__context')).toHaveTextContent(
			'OpenID Connect（RP）'
		);
		await userEvent.type(canvas.getByRole('textbox', { name: '名前' }), 'Reading room');
		await next(canvas);
		await userEvent.click(button(canvas, '設定に進む'));
		await expect(
			await canvas.findByRole('heading', { level: 2, name: '概要' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('heading', { name: '残りの設定' })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>
