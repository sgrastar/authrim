<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import {
		fakeAccountPages,
		sampleAccountScreens,
		sampleLauncherChoices,
		sampleDocument
	} from '#lib/api/fake/account-pages-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import AccountPageEditor from './AccountPageEditor.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Customization/Account page/Editor',
		component: AccountPageEditor,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'One account page (`/admin/customization/account-page/<id>`). The Layout tab has the screens to place on the left, the page in the middle (a full place across the page, two half places side by side; Up and Down move a place) and the selected place’s settings on the right (shown, width, condition, guests). Preview draws it roughly; Localization holds the page heading and description in each language. The page name is edited in the title. Save keeps the draft; Publish saves what is on screen and makes it the live page, with a snapshot of every screen it places (refused when a screen is missing or inactive, has two account widgets, or a link points at a place that is not always shown). There is no rollback.'
				}
			}
		}
	});

	const listHref = '#list';
	const screenHref = (id: string) => `#screen-${id}`;
</script>

<Story
	name="Layout"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ap.inspector.none'));
		// A row of two columns holds two half-width places.
		await expect(canvas.getAllByRole('button', { name: /^2 columns/ }).length).toBeGreaterThan(0);
		await userEvent.click(canvas.getByRole('button', { name: /^Select Profile/ }));
		await canvas.findByText(t('ap.inspector.condition'));
		await expect(canvas.getByText('profile')).toBeVisible();
	}}
>
	{#snippet template()}
		<AccountPageEditor
			client={fakeAccountPages({ delay: 80 })}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Make a row two columns, remove and add, then save"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ap.inspector.none'));
		// Overview was a full-width place; two columns make it half width.
		await userEvent.click(canvas.getAllByRole('button', { name: /^2 columns/ })[0]);
		await userEvent.click(canvas.getByRole('button', { name: /^Select Devices/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('ap.inspector.remove') }));
		// A removed screen is offered again on the left.
		await userEvent.click(await canvas.findByRole('button', { name: /Devices/ }));
		// It comes back under the id it had, so a link to it keeps working.
		await expect(await canvas.findByText('devices')).toBeVisible();
		await userEvent.click(await body.findByRole('button', { name: /^Save/ }));
		await body.findByText(t('ap.toast.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageEditor
			client={fakeAccountPages()}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Edit the page name"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ap.inspector.none'));
		await userEvent.click(canvas.getByRole('button', { name: t('ap.editor.editName') }));
		const field = await canvas.findByLabelText(t('ap.editor.name'));
		await userEvent.clear(field);
		await userEvent.type(field, 'Staff account page');
		await userEvent.click(canvas.getByRole('button', { name: t('ap.editor.nameDone') }));
		await canvas.findByRole('heading', { name: 'Staff account page' });
	}}
>
	{#snippet template()}
		<AccountPageEditor
			client={fakeAccountPages()}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Choose the launchers of the launcher slot"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ap.inspector.none'));
		await userEvent.click(canvas.getByRole('button', { name: /^Select Applications/ }));
		// Every launcher is shown until some are chosen.
		await canvas.findByText(t('ap.launchers.allNote'));
		await userEvent.click(canvas.getByRole('radio', { name: t('ap.launchers.selected') }));
		await canvas.findByText(t('ap.launchers.empty'));
		await userEvent.click(await canvas.findByRole('checkbox', { name: 'Library' }));
		await userEvent.click(canvas.getByRole('checkbox', { name: 'Mail' }));
		await expect(canvas.queryByText(t('ap.launchers.empty'))).toBeNull();
		// A launcher that is switched off is listed as such.
		await expect(canvas.getByRole('checkbox', { name: /Staff wiki/ })).not.toBeChecked();
		await userEvent.click(await body.findByRole('button', { name: /^Save/ }));
		await body.findByText(t('ap.toast.saved'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageEditor
			client={fakeAccountPages()}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
			loadLaunchers={async () => sampleLauncherChoices()}
		/>
	{/snippet}
</Story>

<Story
	name="Publish"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ap.state.unpublished'));
		await userEvent.click(canvas.getByRole('button', { name: t('ap.publish') }));
		await body.findByText(t('ap.toast.published'));
		await canvas.findByText(t('ap.state.published'));
		await canvas.findByText(t('ap.inUse'));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('ap.publish') })).toBeDisabled()
		);
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageEditor
			client={fakeAccountPages()}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="A page that cannot be published"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		toast.dismissAll();
		await canvas.findByText(t('ap.state.unpublished'));
		await userEvent.click(canvas.getByRole('button', { name: t('ap.publish') }));
		await body.findByText(/turned off or does not exist/);
		await canvas.findByText(t('ap.state.unpublished'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<AccountPageEditor
			client={fakeAccountPages({ screens: sampleAccountScreens().slice(1) })}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Preview and localization"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ap.inspector.none'));
		await userEvent.click(canvas.getByRole('tab', { name: t('ap.tab.preview') }));
		await canvas.findByText(t('ap.preview.note'));
		await userEvent.click(canvas.getByRole('tab', { name: t('ap.tab.localize') }));
		const heading = await canvas.findByLabelText(t('ap.text.titleField'));
		await userEvent.type(heading, 'My account');
		await expect(heading).toHaveValue('My account');
		await canvas.findByText(t('ap.text.title'));
	}}
>
	{#snippet template()}
		<AccountPageEditor
			client={fakeAccountPages()}
			id="authrim-default"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="A page changed since it was published"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ap.state.changed'));
		await expect(canvas.getByRole('button', { name: t('ap.publish') })).toBeEnabled();
	}}
>
	{#snippet template()}
		<AccountPageEditor
			client={fakeAccountPages({ document: sampleDocument() })}
			id="partners"
			canWrite
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ap.editor.readOnly'));
		await expect(canvas.queryByRole('button', { name: t('ap.publish') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('ap.editor.editName') })).toBeNull();
		// A reader sees the page in the preview; the layout is not offered to be changed.
		await expect(canvas.queryByRole('tab', { name: t('ap.tab.builder') })).toBeNull();
		await canvas.findByText(t('ap.preview.note'));
	}}
>
	{#snippet template()}
		<AccountPageEditor
			client={fakeAccountPages({ document: sampleDocument() })}
			id="employees"
			canWrite={false}
			{listHref}
			{screenHref}
		/>
	{/snippet}
</Story>

<Story
	name="Page not found"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ap.editor.missing'));
	}}
>
	{#snippet template()}
		<AccountPageEditor client={fakeAccountPages()} id="nope" canWrite {listHref} {screenHref} />
	{/snippet}
</Story>
