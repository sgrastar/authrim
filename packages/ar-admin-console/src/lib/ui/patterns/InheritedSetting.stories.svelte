<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import FieldsDemo from '../stories/FieldsDemo.svelte';
	import InheritedSetting from './InheritedSetting.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Inherited setting',
		component: InheritedSetting,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'One setting whose value can come from a wider scope (the platform default for every tenant) or be set here. A quiet line under the control says which applies and shows the default, with the one action that switches: “Override for this tenant” makes the control editable; “Use the default” shows the default again. The control is the page’s own, given `inherited` so it can be disabled and show the default. Switching is part of the page’s draft (`field`) and saved with everything else.\n\nThe story is an application’s settings page using the field parts together: an inherited lifetime, durations, a limit, redirect URIs, a stored secret, owners found by search and advanced options folded away.'
				}
			}
		}
	});
</script>

<Story
	name="In a settings page"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const lifetime = canvas.getAllByRole('textbox')[0];
		await expect(lifetime).toBeDisabled();
		await userEvent.click(
			canvas.getByRole('button', {
				name: t('inherit.override', { target: t('inherit.targetTenant') })
			})
		);
		await waitFor(() => expect(lifetime).toBeEnabled());
		await expect(canvas.getByRole('button', { name: t('inherit.reset') })).toBeInTheDocument();
	}}
>
	{#snippet template()}<FieldsDemo />{/snippet}
</Story>
