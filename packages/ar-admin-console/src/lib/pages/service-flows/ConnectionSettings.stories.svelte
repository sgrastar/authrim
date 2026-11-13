<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import type { ComponentProps } from 'svelte';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import Page from '#lib/ui/templates/Page.svelte';
	import AddConnection from './AddConnection.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Connection settings',
		component: AddConnection,
		// UI prototype: dummy copy and dummy results, not connected to any API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A connection’s own settings, on its service flow below the overview: how it behaves rather than what Authrim does with the people who pass through. An OpenID Connect app has its profile, grant types, tokens, logout, security and token exchange; a SAML service its addresses, profile and signing, encryption, assertion and metadata refresh; an OpenID provider its endpoints, how Authrim asks, accounts and button; a SAML provider its addresses, certificates, assertion, accounts and metadata refresh. Each is a closed section that starts with the backend’s own default; a section opens by itself, marked Required, only when a choice in it needs more (a pairwise subject needs its sector address, encryption needs the service’s certificate), and that also holds back activation. Everything is dummy: nothing is saved.'
				}
			}
		}
	});

	/** The headings of the closed sections in the connection settings card. */
	const summaries = (root: HTMLElement) => [
		...root.querySelectorAll<HTMLElement>('.detail__settings summary')
	];
	/** Opens the section whose heading starts with `name`. */
	async function section(root: HTMLElement, name: RegExp) {
		const summary = summaries(root).find((candidate) => name.test(candidate.textContent!.trim()));
		await expect(summary).toBeDefined();
		// Already open: leave it (a second click would fold it away).
		if (summary!.closest('details')!.open) return;
		await userEvent.click(summary!);
		// Let the slide finish, so neither the queries nor the accessibility check meet a
		// half-faded field.
		const details = summary!.closest('details')!;
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
	}
</script>

{#snippet frame(args: ComponentProps<typeof AddConnection>)}
	<Page>
		<AddConnection {...args} />
	</Page>
{/snippet}

<!-- An app: every section is there, closed; a pairwise subject wants its sector address. -->
<Story
	name="RP: all settings"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const headings = summaries(canvasElement).map((summary) => summary.textContent!.trim());
		for (const name of [
			/^App profile/,
			/^Grant types/,
			/^Tokens/,
			/^Logout/,
			/^Security/,
			/^Token exchange/
		])
			await expect(headings.some((heading) => name.test(heading))).toBe(true);
		await section(canvasElement, /^Security/);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Subject type' }),
			'pairwise'
		);
		await expect(
			canvas.getByRole('textbox', { name: /Sector identifier URI/ })
		).toBeInTheDocument();
		// Required now, and activating says so.
		await waitFor(() => expect(canvas.getByText(/Still required:.*Security/)).toBeInTheDocument());
		await userEvent.type(
			canvas.getByRole('textbox', { name: /Sector identifier URI/ }),
			'https://reading.example.com/sector.json'
		);
		await waitFor(() => expect(canvas.queryByText(/Still required:.*Security/)).toBeNull());
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Refresh token settings only show while the refresh token grant is chosen. -->
<Story
	name="RP: tokens follow the grants"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Tokens/);
		await expect(canvas.getByRole('switch', { name: 'Rotate refresh tokens' })).toBeInTheDocument();
		await section(canvasElement, /^Grant types/);
		await userEvent.click(canvas.getByRole('checkbox', { name: 'Refresh token' }));
		await expect(canvas.queryByRole('switch', { name: 'Rotate refresh tokens' })).toBeNull();
		await expect(canvas.getByText(/no refresh tokens are issued/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A single-page app cannot keep a secret: no client credentials, refresh tokens only with DPoP. -->
<Story
	name="RP: a single-page app"
	args={{ prefill: 'rp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'App type' }), 'spa');
		await section(canvasElement, /^Grant types/);
		await expect(canvas.getByRole('checkbox', { name: 'Client credentials' })).toBeDisabled();
		await expect(
			canvas.getByRole('combobox', { name: 'Refresh tokens in the browser' })
		).toHaveValue('disabled');
		await section(canvasElement, /^Token exchange/);
		await expect(canvas.queryByRole('switch', { name: 'Allow client credentials' })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A profile sets the signing and checking; each can still be changed afterwards. -->
<Story
	name="SP: profile and signing"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Profile and signing/);
		const assertions = canvas.getByRole('switch', { name: 'Sign the assertion' });
		await expect(assertions).not.toBeChecked();
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Profile' }), 'strict');
		await expect(assertions).toBeChecked();
		await expect(canvas.getByRole('combobox', { name: 'AuthnRequest signature' })).toHaveValue(
			'required'
		);
		await userEvent.click(canvas.getByRole('switch', { name: 'Sign the response' }));
		await userEvent.click(assertions);
		await expect(await canvas.findByText(/cannot trust what it receives/)).toBeInTheDocument();
		// Closed again, the section still says something inside has changed.
		const summary = summaries(canvasElement).find((el) =>
			/^Profile and signing/.test(el.textContent!.trim())
		)!;
		await userEvent.click(summary);
		await expect(
			await within(summary).findByText('Changed', undefined, { timeout: 4000 })
		).toBeInTheDocument();
		// Let the fold finish too: the accessibility check runs after this and must not meet the
		// fields half-faded.
		const details = summary.closest('details')!;
		await waitFor(() => expect(details.getAnimations({ subtree: true })).toHaveLength(0));
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A passed test belongs to what was tested: a profile that changes the NameID takes it back. -->
<Story
	name="SP: a new NameID needs a new test"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Run the test' }));
		await expect(await canvas.findByRole('list', { name: 'Test results' })).toBeInTheDocument();
		await section(canvasElement, /^Profile and signing/);
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Profile' }), 'legacy');
		await waitFor(() => expect(canvas.queryByRole('list', { name: 'Test results' })).toBeNull());
		await expect(canvas.getByRole('button', { name: 'Run the test' })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A test still running when a setting changes ran against the old one: its result is dropped. -->
<Story
	name="SP: a change during the test drops its result"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Profile and signing/);
		await userEvent.click(canvas.getByRole('button', { name: 'Run the test' }));
		await userEvent.click(canvas.getByRole('switch', { name: 'Sign the assertion' }));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: 'Run the test' })).not.toHaveAttribute(
				'aria-busy',
				'true'
			)
		);
		await new Promise((resolve) => setTimeout(resolve, 900));
		await expect(canvas.queryByRole('list', { name: 'Test results' })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Defaults set above the connection: used until overridden; no default, nothing to override. -->
<Story
	name="SP: defaults from the platform and the service"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Assertion/);
		// Switching builds the control again, so it is looked up afresh each time.
		const mode = () => canvas.getByRole('combobox', { name: /AuthnContextClassRef is chosen/ });
		const row = (control: HTMLElement) => within(control.closest('.inherit') as HTMLElement);
		// The tenant's service defaults set it: shown, and locked until overridden.
		await expect(
			row(mode()).getByText(/Using the default from the service defaults/)
		).toBeVisible();
		await expect(mode()).toBeDisabled();
		await userEvent.click(
			row(mode()).getByRole('button', { name: 'Override for this connection' })
		);
		await waitFor(() => expect(mode()).toBeEnabled());
		await userEvent.selectOptions(mode(), 'assurance');
		// Back on the default, the default's value applies again.
		await userEvent.click(row(mode()).getByRole('button', { name: 'Use the default' }));
		await waitFor(() => expect(mode()).toHaveValue('session'));
		await expect(mode()).toBeDisabled();
		// What was typed while overridden goes with the override: back on the default, no error.
		const lifetime = () => canvas.getByRole('textbox', { name: 'Assertion lifetime' });
		await userEvent.click(
			row(lifetime()).getByRole('button', { name: 'Override for this connection' })
		);
		await waitFor(() => expect(lifetime()).toBeEnabled());
		await userEvent.clear(lifetime());
		await userEvent.type(lifetime(), '0');
		await userEvent.tab();
		await expect(lifetime()).toHaveAttribute('aria-invalid', 'true');
		await userEvent.click(row(lifetime()).getByRole('button', { name: 'Use the default' }));
		await waitFor(() => expect(lifetime()).toBeDisabled());
		await expect(lifetime()).toHaveValue('5');
		await expect(lifetime()).not.toHaveAttribute('aria-invalid', 'true');
		// The minimum IAL has no default above it: it is simply set here.
		const ial = canvas.getByRole('combobox', { name: /Identity assurance required/ });
		await expect(ial).toBeEnabled();
		await expect(ial.closest('.inherit')).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Encryption needs the service's certificate: required until it is given. -->
<Story
	name="SP: encryption"
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Encryption/);
		await userEvent.click(canvas.getByRole('switch', { name: 'Encrypt the assertion' }));
		const cert = canvas.getByRole('textbox', { name: /encryption certificate/ });
		await expect(cert).toBeRequired();
		// Once given, it is no longer required, but the section stays open around the field.
		await userEvent.type(cert, '-----BEGIN CERTIFICATE-----');
		await expect(cert.closest('details')).toHaveAttribute('open');
		await expect(cert).toHaveFocus();
		// The key transport comes from the platform's default until this connection overrides it.
		// (Switching builds the control again, so it is looked up afresh.)
		const transport = () => canvas.getByRole('combobox', { name: 'Key transport' });
		await expect(transport()).toBeDisabled();
		await userEvent.click(
			within(transport().closest('.inherit') as HTMLElement).getByRole('button', {
				name: 'Override for this connection'
			})
		);
		await waitFor(() => expect(transport()).toBeEnabled());
		await userEvent.selectOptions(transport(), 'rsa-oaep-sha1');
		await expect(await canvas.findByText(/only for services that need them/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- A template fills in what it knows; FAPI 2.0 decides how Authrim proves itself. -->
<Story
	name="OP: template and FAPI 2.0"
	args={{ prefill: 'op', review: true, filled: 'wizard' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Endpoints/);
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Template' }), 'google');
		await expect(
			await canvas.findByRole('heading', { level: 1, name: 'Google' })
		).toBeInTheDocument();
		await section(canvasElement, /^How Authrim asks/);
		await expect(canvas.getByRole('textbox', { name: 'Scopes requested' })).toHaveValue(
			'openid email profile'
		);
		// A template for a provider without discovery brings its addresses with it.
		await section(canvasElement, /^Endpoints/);
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Template' }), 'github');
		await expect(canvas.getByRole('textbox', { name: 'Token endpoint' })).toHaveValue(
			'https://github.com/login/oauth/access_token'
		);
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Protocol' }), 'oidc');
		await userEvent.click(canvas.getByRole('switch', { name: 'Connect with FAPI 2.0' }));
		const auth = canvas.getByRole('combobox', { name: 'How Authrim proves who it is' });
		await expect(auth).toBeDisabled();
		await expect(auth).toHaveValue('private_key_jwt');
		await expect(canvas.queryByRole('switch', { name: 'Send a signed request object' })).toBeNull();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Trusting the provider's addresses is warned about while people are matched by verified email. -->
<Story
	name="OP: accounts"
	args={{ prefill: 'op', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Account creation/);
		// Matching people stays a step of the flow: it is not asked again here.
		await expect(canvas.queryByRole('switch', { name: /verified email/ })).toBeNull();
		await userEvent.click(
			canvas.getByRole('switch', { name: 'Treat the provider’s email addresses as verified' })
		);
		await expect(await canvas.findByText(/someone else’s account/)).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- The certificates read from the metadata: the one in use and the next, with their expiry. -->
<Story
	name="IdP: certificates"
	args={{ prefill: 'idp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Certificates/);
		const list = within(canvas.getByRole('list', { name: 'Certificates' }));
		await expect(list.getByText('29 days left')).toBeInTheDocument();
		await userEvent.click(list.getByRole('button', { name: 'Make it the one in use' }));
		await expect(list.getAllByText('In use')).toHaveLength(1);
		await expect(list.getByText('444 days left')).toBeInTheDocument();
		await expect(list.queryByText('29 days left')).toBeNull();
		// Without a certificate in use, the provider cannot be trusted: required.
		await userEvent.click(list.getByRole('button', { name: 'Remove' }));
		await expect(await canvas.findByText('No certificates')).toBeInTheDocument();
		await waitFor(() =>
			expect(canvas.getByText(/Still required:.*Certificates/)).toBeInTheDocument()
		);
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- Requiring an authentication context needs at least one to accept. -->
<Story
	name="IdP: authentication context"
	args={{ prefill: 'idp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await section(canvasElement, /^Assertion/);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Authentication context' }),
			'require_any'
		);
		await expect(canvas.getByRole('button', { name: 'Add class reference' })).toBeInTheDocument();
		await waitFor(() => expect(canvas.getByText(/Still required:.*Assertion/)).toBeInTheDocument());
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>

<!-- In Japanese, as the console's language follows. -->
<Story
	name="In Japanese"
	globals={{ locale: 'ja' }}
	args={{ prefill: 'sp', review: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: '接続詳細設定' })).toBeInTheDocument();
		await section(canvasElement, /^プロファイルと署名/);
		await expect(canvas.getByRole('switch', { name: 'Assertion に署名する' })).toBeInTheDocument();
	}}
>
	{#snippet template(args)}{@render frame(args)}{/snippet}
</Story>
