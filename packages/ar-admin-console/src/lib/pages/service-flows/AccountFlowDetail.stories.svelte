<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AccountFlowFrame from './AccountFlowFrame.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Account flows',
		component: AccountFlowFrame,
		// UI prototype: dummy copy, not connected to any API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The sign-up and sign-in flows every tenant has, whether or not anything is connected. Each is one fixed contract that the Login UI and a UI of your own share: the caller at both ends, Authrim’s own steps between, each with its settings and how far it has got. Choosing a setting opens it on the right. Settings that apply to the whole sign-up flow (who can sign up, an address that is already registered, verifying the person) are not a step: they sit in a frame of their own where other flows show their overview. Nothing is preselected, so a setting is done only once someone chose its values. The optional step (consent at sign-up, an additional sign-in) is added with the flow’s “+” and taken away with its ×.'
				}
			}
		}
	});

	const inFlow = (root: HTMLElement, name: RegExp | string) =>
		within(root.querySelector<HTMLElement>('.detail__flow')!).getByRole('button', { name });
	/** The panel on the right, where the back-to-overview button is. */
	const flowButtonsOf = (root: HTMLElement) =>
		within(root.querySelector<HTMLElement>('.detail__flow')!);
	const inPanel = (root: HTMLElement) => within(root.querySelector<HTMLElement>('.detail__panel')!);
</script>

<!-- Nothing is set: every step says so. Sign-up has no overview: its flow-wide settings are there instead. -->
<Story
	name="Sign-up, nothing set"
	args={{ flow: 'registration', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: 'Sign-up', level: 1 })).toBeInTheDocument();
		await expect(canvas.getByText('Being set up')).toBeInTheDocument();
		// They are a frame of their own above the overview, not part of it.
		await expect(canvas.getByRole('heading', { name: 'General settings' })).toBeInTheDocument();
		// The flow's own settings are at the top of the overview, not a step of the flow: a name
		// and a place, both required.
		await expect(canvas.getByRole('textbox', { name: /Service flow name/ })).toBeRequired();
		await expect(canvas.getByRole('combobox', { name: /Where it is used/ })).toBeRequired();
		await expect(
			within(canvasElement.querySelector<HTMLElement>('.detail__flow')!).queryByRole('button', {
				name: /^Name and where it is used/
			})
		).toBeNull();
		// What is asked for is the screens' (and the attribute schema's): no step of its own.
		await expect(
			flowButtonsOf(canvasElement).queryByRole('button', { name: /^Details and schema/ })
		).toBeNull();
		// The optional step is not in the flow until it is added.
		await expect(canvas.queryByRole('button', { name: /^Consent statements/ })).toBeNull();
		// No overview: the flow-wide settings take its place, and they are not steps of the flow.
		await expect(canvas.queryByRole('heading', { name: 'Overview' })).toBeNull();
		await expect(canvas.queryByRole('heading', { name: 'Still to do' })).toBeNull();
		// Each in a frame of its own, creating the account included.
		for (const name of ['Accepting sign-ups', 'Verifying the email address'])
			await expect(canvas.getByRole('heading', { name, level: 2 })).toBeInTheDocument();
		// The default sign-in method profile is chosen from the start; the screen is not.
		await expect(inFlow(canvasElement, /^Sign-in method profile.*Configured/)).toBeInTheDocument();
		// Nothing is left to set: the screen starts as the tenant's built-in sign-up screen.
		await expect(inFlow(canvasElement, /^Screen(?! \d).*Configured/)).toBeInTheDocument();
		// What happens after sign-up is the flow's last step.
		await expect(inFlow(canvasElement, /^After completion/)).toBeInTheDocument();
		const flowButtons = within(canvasElement.querySelector<HTMLElement>('.detail__flow')!);
		await expect(
			flowButtons.queryByRole('button', { name: /^Verifying the email address/ })
		).toBeNull();
		await expect(
			canvas.getByRole('combobox', { name: /When the email address is already registered/ })
		).toBeRequired();
		await expect(canvas.getByRole('combobox', { name: /Who can sign up/ })).toBeRequired();
		await expect(canvas.getByRole('combobox', { name: /When to verify/ })).toBeRequired();
		// Opening a step and going back returns to the flow-wide settings, which keep what was chosen.
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /Who can sign up/ }),
			'invite'
		);
		await userEvent.click(inFlow(canvasElement, /^Screen(?! \d)/));
		await userEvent.click(
			inPanel(canvasElement).getByRole('button', { name: 'Flow-wide settings' })
		);
		await expect(canvas.getByRole('combobox', { name: /Who can sign up/ })).toHaveValue('invite');
	}}
></Story>

<!-- Sign-up chooses one of the tenant's sign-in method profiles, shows what it allows, and can make a new one in place. -->
<Story
	name="Sign-up chooses a sign-in method profile"
	args={{ flow: 'registration', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^Sign-in method profile/));
		const profile = await canvas.findByRole('combobox', { name: /Profile to use/ });
		await expect(profile).toBeRequired();
		await userEvent.selectOptions(profile, 'default');
		// The chosen profile is shown below, as it is: it is changed on its own page.
		await expect(
			await canvas.findByRole('heading', { name: 'What “Default” allows' })
		).toBeInTheDocument();
		await expect(
			canvas.getByRole('checkbox', {
				name: `${t('am.methods.passkey')} / ${t('am.methods.signup')}`
			})
		).toBeDisabled();
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Sign-in method profile.*Configured/)).toBeInTheDocument()
		);
		// A new profile is made in place, saved as a profile, and chosen.
		await userEvent.click(canvas.getByRole('button', { name: 'Create a sign-in method profile' }));
		const name = await canvas.findByRole('textbox', { name: /Profile name/ });
		await waitFor(() => expect(name).toHaveFocus());
		await userEvent.click(canvas.getByRole('button', { name: 'Save and choose' }));
		await expect(await canvas.findByText(t('am.page.nameRequired'))).toBeInTheDocument();
		await userEvent.type(name, 'Members');
		await userEvent.click(canvas.getByRole('button', { name: 'Save and choose' }));
		await expect(
			await canvas.findByRole('heading', { name: 'What “Members” allows' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('combobox', { name: /Profile to use/ })).toHaveDisplayValue(
			'Members'
		);
	}}
></Story>

<!-- After sign-up the person can go on to sign in to another service, by OpenID Connect (a client and its redirect URI) or by SAML (a service provider), each chosen from a list, not typed. -->
<Story
	name="Sign-up goes on to sign in to another service"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^After completion/));
		const after = await canvas.findByRole('combobox', { name: /^After completion/ });
		await userEvent.selectOptions(after, 'app_login');
		const service = await canvas.findByRole('combobox', { name: /^Service to sign in to/ });
		const back = await canvas.findByRole('combobox', { name: /^Where the service is returned to/ });
		// No service yet: no redirect URI to choose.
		await expect(back).toBeDisabled();
		await userEvent.selectOptions(service, 'client_member_app');
		await waitFor(() => expect(back).toBeEnabled());
		const uris = [...(back as HTMLSelectElement).options].map((option) => option.value);
		await expect(uris).toContain('https://app.example.com/callback');
		await expect(uris).not.toContain('https://partners.example.com/oidc/callback');
		await userEvent.selectOptions(back, 'https://app.example.com/callback');
		// Another service: the URI chosen for the one before is not kept.
		await userEvent.selectOptions(service, 'client_partner_portal');
		await waitFor(() => expect(back).toHaveValue(''));
		// By SAML: one of the tenant's enabled service providers, and a RelayState if wanted.
		await userEvent.selectOptions(after, 'saml_login');
		const sp = await canvas.findByRole('combobox', { name: /^Service to sign in to \(SP\)/ });
		const providers = [...(sp as HTMLSelectElement).options].map((option) => option.value);
		await expect(providers).toContain('https://lms.example.edu/shibboleth');
		// The one turned off is not offered.
		await expect(providers).not.toContain('https://wiki.example.com/saml/metadata');
		await expect(canvas.getByRole('textbox', { name: /^RelayState/ })).toBeInTheDocument();
	}}
></Story>

<!-- The screen is chosen among the sign-up screens only (not the built-in templates), starting as the built-in one; screens are made and changed on their own page. -->
<Story
	name="Sign-up chooses a sign-up screen"
	args={{ flow: 'registration', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^Screen(?! \d)/));
		const screen = await canvas.findByRole('combobox', { name: /^Screen/ });
		await expect(screen).toBeRequired();
		await waitFor(() => expect(screen).toHaveValue('registration'));
		const offered = [...(screen as HTMLSelectElement).options].map((option) => option.value);
		await expect(offered).toContain('registration_custom');
		await expect(offered).not.toContain('login_template');
		await expect(offered).not.toContain('registration_template');
		await userEvent.selectOptions(screen, 'registration_custom');
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Screen(?! \d).*Configured/)).toBeInTheDocument()
		);
		await expect(canvas.getByRole('link', { name: /Open the screens/ })).toHaveAttribute(
			'href',
			'/admin/customization/screens'
		);
		// Beside the preview, what the screen asks for: its input parts, the required ones marked.
		const asked = await canvas.findByRole('table', { name: 'What it asks for' });
		await expect(within(asked).getByText('given_name')).toBeInTheDocument();
		await expect(within(asked).getAllByText('Required')).toHaveLength(2);
		await expect(within(asked).getAllByText('Profile')).toHaveLength(3);
		// The method is chosen on the first screen and the flow goes on by it: no ways out to route.
		await expect(canvas.queryByRole('heading', { name: 'Where the ways out lead' })).toBeNull();
	}}
></Story>

<!-- A screen step's title is its own: the pencil beside it edits it in place, as a sign-in method profile's name is edited. -->
<Story
	name="Sign-up renames a screen step"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^Screen(?! \d)/));
		await userEvent.click(await canvas.findByRole('button', { name: 'Edit the title' }));
		const title = canvas.getByRole('textbox', { name: 'Title' });
		await waitFor(() => expect(title).toHaveFocus());
		// Empty: said so, and still editing.
		await userEvent.clear(title);
		await userEvent.click(canvas.getByRole('button', { name: 'Done' }));
		await expect(await canvas.findByText('Enter a title.')).toBeInTheDocument();
		await userEvent.type(title, 'Your details');
		await userEvent.click(canvas.getByRole('button', { name: 'Done' }));
		await expect(
			await canvas.findByRole('heading', { level: 2, name: 'Your details' })
		).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^Your details/)).toBeInTheDocument();
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: 'Edit the title' })).toHaveFocus()
		);
		// Escape leaves it as it was.
		await userEvent.click(canvas.getByRole('button', { name: 'Edit the title' }));
		await userEvent.type(canvas.getByRole('textbox', { name: 'Title' }), ' and more{Escape}');
		await expect(
			canvas.getByRole('heading', { level: 2, name: 'Your details' })
		).toBeInTheDocument();
	}}
></Story>

<!-- More screens after the sign-up one, each a step of its own added with the "+" ("Screen 2", "Screen 3"…): a sign-up screen or one of one's own, with its preview. -->
<Story
	name="Sign-up adds more screens as steps"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const addAfterScreen = async () => {
			await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
			await userEvent.click(await canvas.findByRole('button', { name: /^Screen \d$/ }));
		};
		await addAfterScreen();
		const first = await canvas.findByRole('combobox', { name: /^Screen/ });
		const offered = [...(first as HTMLSelectElement).options].map((option) => option.value);
		await expect(offered).toContain('welcome_survey');
		await expect(offered).not.toContain('login_template');
		await userEvent.selectOptions(first, 'welcome_survey');
		await expect(
			await canvas.findByRole('group', { name: 'Preview of the chosen screen' })
		).toBeInTheDocument();
		await waitFor(() => expect(inFlow(canvasElement, /^Screen 2.*Configured/)).toBeInTheDocument());
		// Where each way out of a more screen leads is the flow's: its submit, and the skip its link
		// part offers, which goes where the submit goes until it is given a place of its own.
		await expect(
			await canvas.findByRole('heading', { name: 'Where the ways out lead' })
		).toBeInTheDocument();
		await expect(canvas.getByRole('combobox', { name: /^Submit \(go on\)/ })).toHaveDisplayValue(
			'The next step'
		);
		const skip = canvas.getByRole('combobox', { name: /^Skip/ });
		await expect(skip).toHaveDisplayValue('Where submitting goes');
		await expect([...(skip as HTMLSelectElement).options].map((option) => option.text)).toContain(
			'Finishing sign-up'
		);
		// A second one: another step in the flow, not another row on the right.
		await addAfterScreen();
		await waitFor(() =>
			expect(
				within(canvasElement.querySelector<HTMLElement>('.detail__flow')!).getAllByRole('button', {
					name: /^Screen \d/
				})
			).toHaveLength(2)
		);
		await expect(inFlow(canvasElement, /^Screen 3.*Not set yet/)).toBeInTheDocument();
		// Optional: the flow stays ready with one unset.
		await expect(canvas.getByText('Active')).toBeInTheDocument();
	}}
></Story>

<Story
	name="Sign-in, nothing set"
	args={{ flow: 'login', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: 'Sign-in', level: 1 })).toBeInTheDocument();
		await expect(
			inFlow(canvasElement, /^Methods and sources.*Required.*Not set yet/)
		).toBeInTheDocument();
		await expect(
			inFlow(canvasElement, /^Establishing the session.*Required.*Not set yet/)
		).toBeInTheDocument();
	}}
></Story>

<Story
	name="Sign-up, everything required is set"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('Active')).toBeInTheDocument();
		await expect(canvas.getByRole('combobox', { name: /Who can sign up/ })).toHaveValue('open');
	}}
></Story>

<Story
	name="Sign-in, everything required is set"
	args={{ flow: 'login', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('Active')).toBeInTheDocument();
	}}
></Story>

<!-- The optional step: the "+" adds it, and it does not hold the flow back while it is unset. -->
<Story
	name="Adding the optional step with the +"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
		await userEvent.click(await canvas.findByRole('button', { name: 'Consent at sign-up' }));
		await expect(
			await canvas.findByRole('heading', { name: 'Consent statements', level: 2 })
		).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^Consent policy.*Not set yet/)).toBeInTheDocument();
		// Added but not set: still ready, and the step is listed as still to do.
		await expect(canvas.getByText('Active')).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('checkbox', { name: 'Terms of use (v3)' }));
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Consent statements.*Configured/)).toBeInTheDocument()
		);
		// It goes again with its ×.
		await userEvent.click(
			canvas.getByRole('button', { name: t('flow.remove', { name: 'Consent at sign-up' }) })
		);
		await waitFor(
			() => expect(canvas.queryByRole('button', { name: /^Consent statements/ })).toBeNull(),
			{ timeout: 3000 }
		);
	}}
></Story>

<!-- Someone from another provider may arrive with no email address, or one that cannot be trusted: they are verified by email too, in the flow-wide settings. -->
<Story
	name="Sign-up verifies provider sign-ups by email"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Not a step to add any more: the "+" offers only consent.
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
		await expect(canvas.queryByRole('button', { name: 'Extra verification' })).toBeNull();
		await userEvent.keyboard('{Escape}');
		await userEvent.selectOptions(canvas.getByRole('combobox', { name: /When to verify/ }), 'none');
		await expect(
			canvas.queryByRole('combobox', { name: /How long the check stays valid/ })
		).toBeNull();
		await userEvent.click(
			canvas.getByRole('checkbox', { name: 'The provider did not give an email address' })
		);
		// Checked by email, with the same expiry; no way to choose SMS.
		await expect(
			await canvas.findByRole('combobox', { name: /How long the check stays valid/ })
		).toBeRequired();
		await expect(canvas.queryByText(/SMS/)).toBeNull();
	}}
/>

<!-- A provider is asked for only when "an external provider" is one of the methods. -->
<Story
	name="An external method asks for the provider"
	args={{ flow: 'login', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(inFlow(canvasElement, /^Methods and sources/));
		await expect(canvas.queryByRole('combobox', { name: 'External provider to use' })).toBeNull();
		await userEvent.click(canvas.getByRole('checkbox', { name: 'An external provider' }));
		await expect(
			await canvas.findByRole('combobox', { name: 'External provider to use' })
		).toBeInTheDocument();
		await userEvent.click(inPanel(canvasElement).getByRole('button', { name: 'Overview' }));
		await expect(canvas.getByText(/An external provider/)).toBeInTheDocument();
	}}
></Story>

<!-- The flows follow the console's language: here Japanese. -->
<Story
	name="In Japanese"
	args={{ flow: 'registration', filled: 'none' }}
	globals={{ locale: 'ja' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: '新規登録', level: 1 })).toBeInTheDocument();
		await expect(canvas.getByText('Authrim が実行する処理')).toBeInTheDocument();
		await expect(inFlow(canvasElement, /^スクリーン(?!\d).*設定済/)).toBeInTheDocument();
		await expect(canvas.getByRole('heading', { name: '登録の受付' })).toBeInTheDocument();
		await expect(canvas.getByRole('combobox', { name: /登録できる人/ })).toBeInTheDocument();
	}}
></Story>

<!-- Not set yet: the list of what is left leads to the name, which is on the overview. -->
<Story
	name="The name is asked for on the overview"
	args={{ flow: 'login', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const todo = within(canvas.getByRole('heading', { name: 'Still to do' }).parentElement!);
		await userEvent.click(todo.getByRole('button', { name: 'Name and where it is used' }));
		await waitFor(() =>
			expect(canvas.getByRole('textbox', { name: /Service flow name/ })).toHaveFocus()
		);
		await userEvent.type(
			canvas.getByRole('textbox', { name: /Service flow name/ }),
			'Partner portal'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /Where it is used/ }),
			'other-ui'
		);
		// The heading follows the name, and the item leaves the list.
		await expect(
			canvas.getByRole('heading', { name: 'Partner portal', level: 1 })
		).toBeInTheDocument();
		await expect(todo.queryByRole('button', { name: 'Name and where it is used' })).toBeNull();
	}}
/>

<!-- SCIM received cannot do without a mapping, and starts from the other system, so it is not run from here. -->
<Story
	name="SCIM received, nothing set"
	args={{ flow: 'scim-in', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole('heading', { name: 'Receive over SCIM', level: 1 })
		).toBeInTheDocument();
		// The other system is the flow's own setting, asked on the overview.
		await expect(canvas.getByRole('textbox', { name: /Name of the other system/ })).toBeRequired();
		// Mapping is a step from the start (a user cannot come in without one), and required.
		await expect(inFlow(canvasElement, /^Mapping set.*Required.*Not set yet/)).toBeInTheDocument();
		await expect(canvas.queryByRole('heading', { name: 'Run' })).toBeNull();
	}}
/>

<!-- A one-shot run of a CSV import: the file is chosen at each run. A demo, so the result is made up. -->
<Story
	name="CSV import, run now"
	args={{ flow: 'csv', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('heading', { name: 'Run', level: 2 })).toBeInTheDocument();
		const run = canvas.getByRole('button', { name: 'Run now' });
		// A file has to be named first.
		await expect(run).toBeDisabled();
		await userEvent.type(canvas.getByRole('textbox', { name: 'File name' }), 'users.csv');
		await expect(run).toBeEnabled();
		await userEvent.click(run);
		const result = await canvas.findByRole('region', { name: 'Result' });
		await expect(within(result).getByText('Processed')).toBeInTheDocument();
		await expect(canvas.getByText(/no user is changed and no file is read/)).toBeInTheDocument();
	}}
/>

<Story
	name="Sending over SCIM waits for its settings"
	args={{ flow: 'scim-out', filled: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: 'Run now' })).toBeDisabled();
		await expect(canvas.getByText(/once the required settings are set/)).toBeInTheDocument();
	}}
/>

<!-- A different file is a different run: changing the name while it runs drops the result of the old one. -->
<Story
	name="Changing the file drops the result"
	args={{ flow: 'csv', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const name = canvas.getByRole('textbox', { name: 'File name' });
		await userEvent.type(name, 'users.csv');
		await userEvent.click(canvas.getByRole('button', { name: 'Run now' }));
		await userEvent.type(name, '2');
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await expect(canvas.queryByRole('region', { name: 'Result' })).toBeNull();
		await expect(canvas.getByRole('button', { name: 'Run now' })).toBeEnabled();
	}}
/>

<!-- Narrowing what is sent asks to what: roles or groups. -->
<Story
	name="SCIM sent: narrowing by role"
	args={{ flow: 'scim-out', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText('Active')).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Users to sync/));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /Users to send/ }),
			'byRole'
		);
		await expect(await canvas.findByRole('checkbox', { name: 'Admin' })).toBeInTheDocument();
		// Not ready until it is said which roles.
		await userEvent.click(inPanel(canvasElement).getByRole('button', { name: 'Overview' }));
		await expect(canvas.getByText('Disabled')).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^Users to sync/));
		await userEvent.click(canvas.getByRole('checkbox', { name: 'Admin' }));
		await userEvent.click(inPanel(canvasElement).getByRole('button', { name: 'Overview' }));
		await expect(canvas.getByText('Active')).toBeInTheDocument();
	}}
/>

<!-- The settings are a draft: the save bar rises once something is changed, and Discard takes it back. -->
<Story
	name="Changes are saved with the save bar"
	args={{ flow: 'login', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bar = () => canvasElement.querySelector<HTMLElement>('.save-bar')!;
		await expect(bar()).not.toHaveClass('is-shown');
		const place = () => canvas.getByRole('combobox', { name: /Where it is used/ });
		await userEvent.selectOptions(place(), 'other-ui');
		await waitFor(() => expect(bar()).toHaveClass('is-shown'));
		// Discard puts back what was saved.
		await userEvent.click(within(bar()).getByRole('button', { name: t('common.discard') }));
		await waitFor(() => expect(bar()).not.toHaveClass('is-shown'));
		await expect(place()).toHaveValue('default-ui');
		// Save keeps it, and the bar sinks again.
		await userEvent.selectOptions(place(), 'other-ui');
		await userEvent.click(within(bar()).getByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(bar()).not.toHaveClass('is-shown'));
		await expect(place()).toHaveValue('other-ui');
	}}
/>
