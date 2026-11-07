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
						'Customization → Screens (`/api/admin/screens`): every screen, the built-in ones first, with a preview of the one picked on the right (under the table on a narrow window). The preview shows the row under the pointer (or holding the focus); a row opens its screen (`…/screens/<id>`). Its menu opens, duplicates or deletes it: a built-in screen, and one a flow or an account page uses, say why they cannot be deleted in place of the action. The list narrows by kind and by name or key.'
				}
			}
		}
	});

	const onopen = fn();
	const hrefOf = (id: string) => `/admin/customization/screens/${id}`;
	const usages = {
		screen_login: [
			{
				kind: 'flow' as const,
				flow_id: 'flow_login',
				flow_name: 'Default sign-in',
				node_id: 'login',
				node_title: 'Sign in',
				stage: 'published' as const
			}
		]
	};
</script>

<Story
	name="Screens with a preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const survey = await canvas.findByText('Welcome survey');
		// The row under the pointer is previewed.
		await userEvent.hover(survey);
		const preview = within(canvas.getByRole('complementary', { name: t('sc.preview.title') }));
		await waitFor(() => expect(preview.getByText(/How did you hear about us\?/)).toBeVisible());
		// A row opens its screen.
		await userEvent.click(survey);
		await waitFor(() => expect(onopen).toHaveBeenCalledWith('screen_survey'));
		// The list narrows by name or key.
		await userEvent.type(canvas.getByRole('searchbox', { name: t('sc.list.search') }), 'login');
		await waitFor(() => expect(canvas.queryByText('Welcome survey')).toBeNull());
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
		await canvas.findAllByText('Sign in');
		await userEvent.click(
			canvas.getByRole('button', { name: t('sc.list.actions', { name: 'Sign in' }) })
		);
		const reason = await within(canvasElement.ownerDocument.body).findByRole('menuitem', {
			name: t('sc.delete.system')
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
