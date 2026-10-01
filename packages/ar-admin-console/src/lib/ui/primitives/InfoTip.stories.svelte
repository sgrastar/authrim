<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { sample } from '../stories/sample';
	import InfoTip from './InfoTip.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Info tip',
		component: InfoTip,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'A "?" that shows a short explanation on hover or focus, for text that would crowd the layout if always shown (a checkbox\'s longer description, what a part in a list does). The bubble is in the top layer, beside the "?" or below it when there is no room, so no scrolling container clips it; Esc closes it. Point another control at the text with `id` + aria-describedby so screen readers read it too — Checkbox does this through its `info` prop.'
				}
			}
		}
	});
</script>

<Story
	name="Default"
	args={{ label: t('common.moreInfo'), text: sample('passkeyDesc') }}
	play={async ({ canvasElement }) => {
		const tip = within(canvasElement).getByRole('button');
		tip.focus();
		const bubble = canvasElement.ownerDocument.getElementById(
			tip.getAttribute('aria-describedby') ?? ''
		);
		await waitFor(() => expect(bubble?.matches(':popover-open')).toBe(true));
		await userEvent.keyboard('{Escape}');
		await waitFor(() => expect(bubble?.matches(':popover-open')).toBe(false));
	}}
/>
