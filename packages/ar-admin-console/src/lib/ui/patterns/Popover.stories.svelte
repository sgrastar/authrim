<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import { sample } from '../stories/sample';
	import Popover from './Popover.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Popover',
		component: Popover,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A trigger with a panel anchored under it: menus in the header (account, display, scope), the tabs\' "More". Closes on an outside click, on Esc (focus returns to the trigger), when a link in the panel is followed, or when the panel calls `close()`. `align` lines the panel up with the start or end edge of the trigger and follows right-to-left. For choosing one value, use Select or SelectMenu instead.'
				}
			}
		}
	});
</script>

{#snippet menu(close: () => void)}
	<ul style="display:grid;gap:2px;margin:0;padding:0;list-style:none">
		<li><a href="#profile" onclick={() => close()}>{sample('displayName')}</a></li>
		<li><a href="#passkeys" onclick={() => close()}>{sample('passkey')}</a></li>
	</ul>
{/snippet}

<Story
	name="Plain trigger"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const trigger = canvas.getByRole('button', { name: t('account.menu') });
		await userEvent.click(trigger);
		await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
		// Esc closes the panel and returns focus to the trigger.
		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
		await expect(trigger).toHaveFocus();
	}}
>
	{#snippet template()}
		<div style="min-height:160px">
			<Popover label={t('account.menu')}>
				{#snippet trigger()}<span>{t('account.menu')}</span>{/snippet}
				{#snippet children({ close })}{@render menu(close)}{/snippet}
			</Popover>
		</div>
	{/snippet}
</Story>

<Story name="Icon trigger, end-aligned">
	{#snippet template()}
		<div style="display:flex;justify-content:flex-end;min-height:160px">
			<Popover label={t('account.menu')} variant="icon" align="end">
				{#snippet trigger()}<Icon name="userCircle" />{/snippet}
				{#snippet children({ close })}{@render menu(close)}{/snippet}
			</Popover>
		</div>
	{/snippet}
</Story>
