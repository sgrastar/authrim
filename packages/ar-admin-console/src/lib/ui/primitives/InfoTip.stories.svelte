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
						'A 16px SVG question icon (about a 13px drawn circle) in a 24 × 24px target. Its plain-text bubble uses the 12px caption size, regular weight, 1.45 line height, 8 × 10px padding and a 260px maximum width. It appears on hover or focus beside the "?", or below/above it when there is no room; Escape closes it. Point another control at the text with `id` + aria-describedby so screen readers read it too — Checkbox does this through its `info` prop.'
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
