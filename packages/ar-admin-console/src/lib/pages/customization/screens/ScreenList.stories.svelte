<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import ScreenList from './ScreenList.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Screens',
		component: ScreenList,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Customization → Screens (`/api/admin/screens`): saved tenant screens and editable default account screens appear in separate tables. Built-in authentication templates appear in the new-screen wizard. A row opens its detail page (`…/screens/<id>`). Its menu opens, duplicates or deletes it when allowed. The list narrows by kind and by name or key. Each table sorts independently, and creation and update dates include the time zone.'
				}
			}
		}
	});

	const onopen = fn();
	const hrefOf = (id: string) => `/admin/customization/screens/${id}`;
	const usages = {
		screen_survey: [
			{
				kind: 'flow' as const,
				flow_id: 'flow_login',
				flow_name: 'Default sign-in',
				node_id: 'survey',
				node_title: 'Welcome survey',
				stage: 'published' as const
			}
		]
	};
</script>

<Story
	name="Saved screens"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const survey = await canvas.findByText('Welcome survey');
		const screensTable = canvas.getByRole('table', { name: t('sc.list.title') });
		const accountTable = canvas.getByRole('table', { name: t('sc.list.accountTable') });
		await expect(within(screensTable).queryByText('User profile')).toBeNull();
		await expect(within(accountTable).getByText('User profile')).toBeInTheDocument();
		await expect(within(accountTable).getAllByRole('row')).toHaveLength(12);
		await expect(canvas.getByText('Sign up')).toBeInTheDocument();
		await expect(canvas.queryByText('Sign in')).toBeNull();
		await expect(canvas.queryByRole('complementary', { name: t('sc.preview.title') })).toBeNull();
		const headers = within(screensTable)
			.getAllByRole('columnheader')
			.map((header) => header.textContent?.trim());
		await expect(headers.indexOf(t('sc.list.col.created'))).toBeLessThan(
			headers.indexOf(t('sc.list.col.updated'))
		);
		// A row opens its screen.
		await userEvent.click(survey);
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('screen_survey'));
		// The list narrows by name or key.
		await userEvent.type(canvas.getByRole('searchbox', { name: t('sc.list.search') }), 'welcome');
		await waitFor(() => expect(canvas.queryByText('Sign up')).toBeNull());
		await expect(canvas.getByText('Welcome survey')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<ScreenList
			client={createFakeScreens({ screens: MOCK_SCREENS, usages })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="A screen in use is not deleted"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Welcome survey');
		await userEvent.click(
			canvas.getByRole('button', { name: t('sc.list.actions', { name: 'Welcome survey' }) })
		);
		const reason = await within(canvasElement.ownerDocument.body).findByRole('menuitem', {
			name: t('sc.delete.inUse')
		});
		await expect(reason).toBeDisabled();
	}}
>
	{#snippet template()}
		<ScreenList
			client={createFakeScreens({ screens: MOCK_SCREENS, usages })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story
	name="Dates and sorting"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Welcome survey');
		const screensTable = within(canvas.getByRole('table', { name: t('sc.list.title') }));
		const firstName = () =>
			within(screensTable.getAllByRole('row')[1]).getAllByRole('cell')[0].textContent ?? '';
		const signupRow = canvas.getByText('Sign up').closest('tr');
		await expect(signupRow).not.toBeNull();
		for (const date of signupRow!.querySelectorAll('time')) {
			await expect(date.textContent).toMatch(/\d{1,2}:\d{2}/);
		}
		await expect(signupRow!.querySelectorAll('time')).toHaveLength(2);
		const updated = screensTable.getByRole('button', { name: t('sc.list.col.updated') });
		await userEvent.click(updated);
		await waitFor(() => expect(firstName()).toContain('Sign up'));
		await userEvent.click(updated);
		await waitFor(() => expect(firstName()).toContain('Welcome survey'));
		await userEvent.click(screensTable.getByRole('button', { name: t('sc.list.col.usage') }));
		await waitFor(() => expect(firstName()).toContain('Sign up'));
	}}
>
	{#snippet template()}
		<ScreenList
			client={createFakeScreens({ screens: MOCK_SCREENS, usages })}
			canWrite
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>

<Story name="Read only">
	{#snippet template()}
		<ScreenList
			client={createFakeScreens({ screens: MOCK_SCREENS, usages })}
			canWrite={false}
			{hrefOf}
			{onopen}
		/>
	{/snippet}
</Story>
