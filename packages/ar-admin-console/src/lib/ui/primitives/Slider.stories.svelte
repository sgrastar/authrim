<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import Slider from './Slider.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Slider',
		component: Slider,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Numeric value on a range, built on a native range input (keyboard, touch and screen readers work unchanged; the value is announced formatted). `format="percent"` shows 0–100 as a percentage; `min`/`max`/`step`/`unit` for anything else. `ticks` takes an interval or explicit values, `tickLabels` prints them, `snapToTicks` restricts the value to them. Fills from the reading start (mirrored in RTL).'
				}
			}
		}
	});
</script>

<Story
	name="Percentage"
	play={async ({ canvasElement }) => {
		const slider = within(canvasElement).getByRole('slider') as HTMLInputElement;
		// Simulated keyboards do not step native range inputs; set the value like a drag would.
		slider.value = '40';
		await fireEvent.input(slider);
		await expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('40'));
	}}
>
	{#snippet template()}
		<div style="max-width:420px">
			<Slider
				label={sample('rolloutShare')}
				value={25}
				format="percent"
				hint={sample('rolloutHint')}
			/>
		</div>
	{/snippet}
</Story>

<Story name="Min, max and ticks">
	{#snippet template()}
		<div style="max-width:420px">
			<Slider
				label={sample('sessionTtl')}
				value={60}
				min={15}
				max={240}
				step={15}
				ticks={45}
				tickLabels
				unit={sample('minutes')}
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="Snap to explicit ticks"
	play={async ({ canvasElement }) => {
		const slider = within(canvasElement).getByRole('slider') as HTMLInputElement;
		// The native range steps over tick positions: position 3 is the fourth tick.
		slider.value = '3';
		await fireEvent.input(slider);
		await expect(slider).toHaveAttribute('aria-valuetext', expect.stringContaining('75'));
	}}
>
	{#snippet template()}
		<div style="max-width:420px">
			<Slider
				label={sample('riskThreshold')}
				value={50}
				ticks={[0, 25, 50, 75, 100]}
				tickLabels
				snapToTicks
				format="percent"
			/>
		</div>
	{/snippet}
</Story>

<Story name="Without value">
	{#snippet template()}
		<div style="max-width:420px">
			<Slider label={sample('volume')} value={40} showValue={false} />
		</div>
	{/snippet}
</Story>
