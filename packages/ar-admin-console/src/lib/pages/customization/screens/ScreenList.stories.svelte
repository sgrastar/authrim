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
						'Customization → Screens (`/api/admin/screens`): saved tenant screens. Built-in templates appear in the new-screen wizard instead of this list. A row opens its detail page (`…/screens/<id>`). Its menu opens, duplicates or deletes it; a screen used by a flow or account page explains why it cannot be deleted. The list narrows by kind and by name or key. The data columns sort, and creation and update dates include the time zone. New screens start from the Create screen action.'
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
		await expect(canvas.getByText('Sign up')).toBeInTheDocument();
		await expect(canvas.queryByText('Sign in')).toBeNull();
		await expect(canvas.queryByRole('complementary', { name: t('sc.preview.title') })).toBeNull();
		const headers = canvas.getAllByRole('columnheader').map((header) => header.textContent?.trim());
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
		const firstName = () =>
			within(canvas.getAllByRole('row')[1]).getAllByRole('cell')[0].textContent ?? '';
		const signupRow = canvas.getByText('Sign up').closest('tr');
		await expect(signupRow).not.toBeNull();
		for (const date of signupRow!.querySelectorAll('time')) {
			await expect(date.textContent).toMatch(/\d{1,2}:\d{2}/);
		}
		await expect(signupRow!.querySelectorAll('time')).toHaveLength(2);
		const updated = canvas.getByRole('button', { name: t('sc.list.col.updated') });
		await userEvent.click(updated);
		await waitFor(() => expect(firstName()).toContain('Sign up'));
		await userEvent.click(updated);
		await waitFor(() => expect(firstName()).toContain('Welcome survey'));
		await userEvent.click(canvas.getByRole('button', { name: t('sc.list.col.usage') }));
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
