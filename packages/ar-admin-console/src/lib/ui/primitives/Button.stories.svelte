<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import Button from './Button.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Button',
		component: Button,
		tags: ['autodocs'],
		args: { onclick: fn() },
		parameters: {
			docs: {
				description: {
					component:
						'Actions. One `primary` button per view; `danger` only for destructive actions, always behind a confirmation. With `href` it renders a link; `external` opens a new tab and adds the mirrored external icon.'
				}
			}
		}
	});
</script>

<Story
	name="Default"
	args={{ variant: 'primary' }}
	play={async ({ args, canvasElement }) => {
		await userEvent.click(within(canvasElement).getByRole('button'));
		await expect(args.onclick).toHaveBeenCalledOnce();
	}}
>
	{#snippet template({ children: _children, ...args })}<Button {...args}>{sample('save')}</Button
		>{/snippet}
</Story>

<Story name="Variants">
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:8px">
			<Button variant="primary" icon="plus">{sample('create')}</Button>
			<Button>{sample('cancel')}</Button>
			<Button variant="ghost">{sample('details')}</Button>
			<Button variant="danger" icon="trash">{sample('delete')}</Button>
		</div>
	{/snippet}
</Story>

<Story name="States">
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:8px">
			<Button size="sm">{sample('details')}</Button>
			<Button loading>{sample('saving')}</Button>
			<Button disabled>{sample('save')}</Button>
			<Button href="https://authrim.com" external>{sample('docs')}</Button>
		</div>
	{/snippet}
</Story>

<Story
	name="Drawing attention"
	parameters={{
		docs: {
			description: {
				story:
					'`attention` marks the one action that can be taken now (Next when a step is complete, Save when there is something to save). The frame pulses slowly. It stops while the button is disabled or running, holds still (marked, not moving) with reduced motion, and should be on one button per view at most.'
			}
		}
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [calling, waiting, running] = [
			canvas.getByRole('button', { name: 'Ready' }),
			canvas.getByRole('button', { name: 'Not yet' }),
			canvas.getByRole('button', { name: 'Running' })
		];
		await expect(getComputedStyle(calling).animationName).toContain('btn-attention');
		await expect(getComputedStyle(calling).animationIterationCount).toBe('infinite');
		await expect(getComputedStyle(waiting).animationName).toBe('none');
		await expect(getComputedStyle(running).animationName).toBe('none');
	}}
>
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:16px;padding:8px">
			<Button attention>Ready</Button>
			<Button attention disabled>Not yet</Button>
			<Button attention loading>Running</Button>
			<Button variant="primary" attention>Ready (primary)</Button>
		</div>
	{/snippet}
</Story>
