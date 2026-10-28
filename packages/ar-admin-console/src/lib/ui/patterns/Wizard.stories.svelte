<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import TextField from '../primitives/TextField.svelte';
	import Wizard from './Wizard.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Wizard',
		component: Wizard,
		tags: ['autodocs'],
		parameters: {
			layout: 'padded',
			docs: {
				description: {
					component:
						'A job too long for one form, asked one step at a time: the steps down the side, the current step’s questions in the middle, Back and Next below. The page owns the list of steps and changes it as answers arrive (what a later step asks can depend on an earlier answer); the wizard only walks it. Moving to a step puts focus on its heading, so a keyboard or screen-reader user lands on the new questions. On a narrow screen the step list gives way to “Step n of m”.'
				}
			}
		}
	});

	const steps = [
		{ id: 'one', label: 'First questions' },
		{ id: 'two', label: 'More questions' },
		{ id: 'three', label: 'Review' }
	];
</script>

<Story
	name="Three steps"
	args={{
		steps,
		description: 'Some words on what this step is for.',
		onfinish: fn(),
		oncancel: fn()
	}}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole('button', { name: t('wizard.back') })).toBeDisabled();
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		// Focus follows to the new step's heading.
		const heading = await canvas.findByRole('heading', { name: 'More questions' });
		await waitFor(() => expect(heading).toHaveFocus());
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.next') }));
		// The last step offers Finish instead of Next.
		await expect(canvas.queryByRole('button', { name: t('wizard.next') })).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('wizard.finish') }));
		await expect(args.onfinish).toHaveBeenCalled();
		await userEvent.click(canvas.getByRole('button', { name: t('common.cancel') }));
		await expect(args.oncancel).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}
		<div style="max-width:880px">
			<Wizard {...args}>
				{#snippet children(step)}
					<TextField label={`A question in “${step.label}”`} />
				{/snippet}
			</Wizard>
		</div>
	{/snippet}
</Story>

<Story
	name="Names what is being set up"
	args={{ steps, current: 1, context: 'OpenID Connect (Relying Party)' }}
	play={async ({ canvasElement }) => {
		const context = canvasElement.querySelector('.wizard__context')!;
		await expect(context).toHaveTextContent('OpenID Connect (Relying Party)');
		// The line sits above the step count.
		await expect(context.nextElementSibling).toHaveTextContent('2');
	}}
>
	{#snippet template(args)}
		<div style="max-width:880px">
			<Wizard steps={args.steps} current={args.current} context={args.context}>
				<TextField label="A question" />
			</Wizard>
		</div>
	{/snippet}
</Story>

<Story
	name="Next waits for an answer"
	args={{ steps, canNext: false }}
	play={async ({ canvasElement }) => {
		const next = within(canvasElement).getByRole('button', { name: t('wizard.next') });
		await expect(next).toBeDisabled();
		await expect(getComputedStyle(next).animationName).toBe('none');
	}}
>
	{#snippet template(args)}
		<div style="max-width:880px">
			<Wizard steps={args.steps} canNext={args.canNext}>
				<TextField label="Required" hint="Next stays off until this is filled in." />
			</Wizard>
		</div>
	{/snippet}
</Story>

<!-- Once the step is complete, Next says so: its frame pulses slowly. -->
<Story
	name="Next is ready"
	args={{ steps, canNext: true }}
	play={async ({ canvasElement }) => {
		const next = within(canvasElement).getByRole('button', { name: t('wizard.next') });
		await expect(next).toBeEnabled();
		await expect(getComputedStyle(next).animationName).toContain('btn-attention');
		// Back is not the action to take.
		const back = within(canvasElement).getByRole('button', { name: t('wizard.back') });
		await expect(getComputedStyle(back).animationName).toBe('none');
	}}
>
	{#snippet template(args)}
		<div style="max-width:880px">
			<Wizard steps={args.steps} canNext={args.canNext}>
				<TextField label="Answered" value="Something" />
			</Wizard>
		</div>
	{/snippet}
</Story>
