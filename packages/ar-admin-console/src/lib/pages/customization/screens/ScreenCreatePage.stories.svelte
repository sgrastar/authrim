<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import ScreenCreatePage from './ScreenCreatePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Create screen',
		component: ScreenCreatePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Create a screen in two steps: choose a saved built-in screen by category and preview it, then enter its display name, immutable key and description. Creation opens the saved copy in the editor.'
				}
			}
		}
	});
	const oncancel = fn();
	const createdFromPreset = fn();
	const createdFromStarter = fn();
</script>

<Story
	name="Create from a built-in screen"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const browser = await canvas.findByRole('group', { name: t('sc.create.templates') });
		await userEvent.click(
			within(browser).getByRole('button', { name: new RegExp(t('sc.create.category.login')) })
		);
		await userEvent.click(within(browser).getByRole('button', { name: 'Sign in' }));
		await waitFor(() => expect(within(browser).getByText('Sign in with Passkey')).toBeVisible());
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await expect(canvas.getByRole('heading', { name: t('sc.create.details') })).toBeVisible();
		await expect(canvas.getByRole('textbox', { name: t('sc.editor.name') })).toHaveValue(
			t('sc.copy.name', { name: 'Sign in' })
		);
		await userEvent.click(canvas.getByRole('button', { name: t('sc.list.create') }));
		await waitFor(() => expect(createdFromPreset).toHaveBeenCalledWith('screen_2'));
	}}
>
	{#snippet template()}
		<ScreenCreatePage
			client={createFakeScreens({ screens: [MOCK_SCREENS[0]] })}
			canWrite
			{oncancel}
			oncreated={createdFromPreset}
		/>
	{/snippet}
</Story>

<Story
	name="Sign-up, sign-in, code and consent templates"
	play={async ({ canvasElement }) => {
		const browser = await within(canvasElement).findByRole('group', {
			name: t('sc.create.templates')
		});
		const categories = within(browser);
		await userEvent.click(
			categories.getByRole('button', { name: new RegExp(t('sc.create.category.registration')) })
		);
		await expect(categories.getByRole('button', { name: 'Registration' })).toBeInTheDocument();
		await userEvent.click(
			categories.getByRole('button', { name: new RegExp(t('sc.create.category.login')) })
		);
		await expect(categories.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
		await expect(categories.getByRole('button', { name: 'Code input' })).toBeInTheDocument();
		await userEvent.click(
			categories.getByRole('button', { name: new RegExp(t('sc.create.category.consent')) })
		);
		await expect(categories.getByRole('button', { name: 'Consent' })).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<ScreenCreatePage
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			canWrite
			{oncancel}
			oncreated={createdFromPreset}
		/>
	{/snippet}
</Story>

<Story
	name="Account templates remain available"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const browser = await canvas.findByRole('group', { name: t('sc.create.templates') });
		await userEvent.click(
			within(browser).getByRole('button', { name: new RegExp(t('sc.create.category.account')) })
		);
		await expect(
			within(browser).getByRole('button', { name: 'Account overview' })
		).toBeInTheDocument();
		await expect(within(browser).getByRole('button', { name: 'User profile' })).toBeInTheDocument();
		await expect(within(browser).queryByRole('button', { name: t('sc.create.blank') })).toBeNull();
		await userEvent.click(within(browser).getByRole('button', { name: 'Account overview' }));
		await expect(canvas.getByRole('button', { name: t('wizard.next') })).toBeEnabled();
	}}
>
	{#snippet template()}
		<ScreenCreatePage
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			canWrite
			{oncancel}
			oncreated={createdFromPreset}
		/>
	{/snippet}
</Story>

<Story
	name="Create a custom starter"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const browser = await canvas.findByRole('group', { name: t('sc.create.templates') });
		await userEvent.click(
			within(browser).getByRole('button', { name: new RegExp(t('sc.create.category.other')) })
		);
		await userEvent.click(within(browser).getByRole('button', { name: t('sc.create.blank') }));
		await waitFor(() =>
			expect(within(browser).getByText(t('sc.create.blankHeading'))).toBeVisible()
		);
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		await userEvent.type(canvas.getByRole('textbox', { name: t('sc.editor.name') }), 'Welcome');
		await userEvent.type(canvas.getByRole('textbox', { name: t('sc.editor.key') }), 'welcome');
		await userEvent.click(canvas.getByRole('button', { name: t('sc.list.create') }));
		await waitFor(() => expect(createdFromStarter).toHaveBeenCalledWith('screen_2'));
	}}
>
	{#snippet template()}
		<ScreenCreatePage
			client={createFakeScreens({ screens: [MOCK_SCREENS[0]] })}
			canWrite
			{oncancel}
			oncreated={createdFromStarter}
		/>
	{/snippet}
</Story>

<Story name="No write permission">
	{#snippet template()}
		<ScreenCreatePage
			client={createFakeScreens({ screens: MOCK_SCREENS })}
			canWrite={false}
			{oncancel}
			oncreated={createdFromStarter}
		/>
	{/snippet}
</Story>
