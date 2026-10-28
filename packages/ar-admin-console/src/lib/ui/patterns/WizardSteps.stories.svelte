<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, fn, within } from 'storybook/test';
	import WizardSteps from './WizardSteps.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Wizard steps',
		component: WizardSteps,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Where you are in a wizard: finished steps ticked, the current one marked, the rest still to come. A finished step can be reopened to change an answer; the steps ahead cannot be jumped to, because what they ask depends on the answers before them. Used inside Wizard.'
				}
			}
		}
	});

	const steps = [
		{ id: 'where', label: 'Where to connect' },
		{ id: 'kind', label: 'What to connect' },
		{ id: 'details', label: 'App details', hint: 'Name and redirect addresses' },
		{ id: 'signin', label: 'Sign-in method' },
		{ id: 'review', label: 'Review' }
	];
</script>

<Story
	name="Half way"
	args={{ steps, current: 2, onselect: fn() }}
	play={async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const list = canvas.getByRole('list', { name: /Steps|手順/ });
		await expect(within(list).getAllByRole('listitem')).toHaveLength(5);
		// Exactly one step is the current one.
		await expect(canvasElement.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
		// A finished step reopens; one ahead is not a button.
		await userEvent.click(canvas.getByRole('button', { name: /Where to connect/ }));
		await expect(args.onselect).toHaveBeenCalledWith(0);
		await expect(canvas.queryByRole('button', { name: /Review/ })).toBeNull();
	}}
/>

<Story
	name="At the start"
	args={{
		steps: steps.slice(0, 2),
		current: 0,
		note: 'More steps appear once you choose what to connect.'
	}}
/>

<Story name="All done" args={{ steps, current: 4 }} />
