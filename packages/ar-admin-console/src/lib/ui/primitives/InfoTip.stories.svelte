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

<!-- A tap opens the bubble and a second tap closes it, with or without focus moving to the button. -->
<Story
	name="Touch"
	args={{ label: t('common.moreInfo'), text: sample('passkeyDesc') }}
	play={async ({ canvasElement }) => {
		const tip = within(canvasElement).getByRole('button');
		const bubble = canvasElement.ownerDocument.getElementById(
			tip.getAttribute('aria-describedby') ?? ''
		);
		const touch = (type: string) =>
			tip.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', bubbles: true }));
		// Chrome on Android: the tap focuses the button before the click.
		touch('pointerdown');
		tip.focus();
		tip.click();
		await waitFor(() => expect(bubble?.matches(':popover-open')).toBe(true));
		// Safari: a tap moves no focus, so no blur ever closes it. The second tap does.
		touch('pointerdown');
		tip.click();
		await waitFor(() => expect(bubble?.matches(':popover-open')).toBe(false));
		// And a third tap opens it again.
		touch('pointerdown');
		tip.click();
		await waitFor(() => expect(bubble?.matches(':popover-open')).toBe(true));
	}}
/>
