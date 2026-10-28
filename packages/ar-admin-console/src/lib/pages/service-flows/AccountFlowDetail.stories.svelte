<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
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
						'The sign-up and sign-in flows every tenant has, whether or not anything is connected. Each is one fixed contract that the Login UI and a UI of your own share: the caller at both ends, Authrim’s own steps between, each with its settings and how far it has got. Choosing a setting opens it on the right. Nothing is preselected, so a setting is done only once someone chose its values. The optional step (consent at sign-up, an additional sign-in) is added with the flow’s “+” and taken away with its ×.'
				}
			}
		}
	});

	const inFlow = (root: HTMLElement, name: RegExp | string) =>
		within(root.querySelector<HTMLElement>('.detail__flow')!).getByRole('button', { name });
	/** The panel on the right, where the back-to-overview button is. */
	const inPanel = (root: HTMLElement) => within(root.querySelector<HTMLElement>('.detail__panel')!);
</script>

<!-- Nothing is set: every step says so, and the overview says what is still to do. -->
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
		// What has to be set in a step carries the Required badge, in front of "Not set yet".
		await expect(
			inFlow(canvasElement, /^Details and schema.*Required.*Not set yet/)
		).toBeInTheDocument();
		// The optional step is not in the flow until it is added.
		await expect(canvas.queryByRole('button', { name: /^Consent statements/ })).toBeNull();
		const todo = within(canvas.getByRole('heading', { name: 'Still to do' }).parentElement!);
		await userEvent.click(todo.getByRole('button', { name: 'Who can sign up' }));
		await expect(
			canvas.getByRole('heading', { name: 'Who can sign up', level: 2 })
		).toBeInTheDocument();
		// Choosing makes the setting done, and the flow keeps what was chosen.
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: 'Who can sign up' }),
			'invite'
		);
		await waitFor(() =>
			expect(inFlow(canvasElement, /^Who can sign up.*Configured/)).toBeInTheDocument()
		);
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
		await expect(canvas.getByText('Everything required is set.')).toBeInTheDocument();
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

<!-- Someone from another provider may arrive with no email address, or one that cannot be trusted. -->
<Story
	name="Adding an extra check to sign-up"
	args={{ flow: 'registration', filled: 'required' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button', { name: t('flow.add') })[0]);
		await userEvent.click(await canvas.findByRole('button', { name: 'Extra verification' }));
		await expect(
			await canvas.findByRole('heading', { name: 'When to verify more', level: 2 })
		).toBeInTheDocument();
		await userEvent.click(
			canvas.getByRole('checkbox', { name: 'The provider did not give an email address' })
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /How to verify/ }),
			'email-code'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /How long the code stays valid/ }),
			'10m'
		);
		await waitFor(() =>
			expect(inFlow(canvasElement, /^When to verify more.*Configured/)).toBeInTheDocument()
		);
		// Optional: the flow was ready before and still is.
		await expect(canvas.getByText('Active')).toBeInTheDocument();
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
		await expect(canvas.getByText('An external provider')).toBeInTheDocument();
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
		await expect(inFlow(canvasElement, /^登録情報・スキーマ.*必須.*未設定/)).toBeInTheDocument();
		await userEvent.click(inFlow(canvasElement, /^登録の受付条件/));
		await expect(canvas.getByRole('combobox', { name: '登録できる人' })).toBeInTheDocument();
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
