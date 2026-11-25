<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ChecklistHarness from './ChecklistHarness.svelte';
	import { CHECKLIST } from './checklist';
	import GuideHarness from './GuideHarness.svelte';
	import GuideSteps from './GuideSteps.svelte';
	import SecondFactorHarness from './SecondFactorHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Overview/First steps',
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The first-steps checklist on the overview, and the guide each item starts. The checklist lists what to try in a new environment; a finished item is checked, and the progress is the signed-in admin’s, per tenant, kept by the Admin API (`/api/admin/me/onboarding`). A guide (Driver.js) goes to the item’s page and points at where to work, one step at a time, across pages; the page stays usable, and steps that wait for the person say what to do in a box of their own. The popover is dressed in the console’s tokens (`guide.css`): the card surface, the type scale, the console’s buttons, no accent stripe. Items and steps are defined in one file, `src/lib/onboarding/checklist.ts`.'
				}
			}
		}
	});

	const popover = (canvasElement: HTMLElement) =>
		waitFor(() => {
			const found = canvasElement.ownerDocument.querySelector<HTMLElement>(
				'.driver-popover.console-guide'
			);
			if (!found) throw new Error('no popover');
			return found;
		});
</script>

<Story
	name="Checklist: nothing done"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('ob.progress', { done: 0, total: CHECKLIST.length }));
		// Every item has a guide and can be checked by hand; the first one is the one to do next.
		await expect(canvas.getAllByRole('listitem')).toHaveLength(CHECKLIST.length);
		const mark = canvas.getByRole('button', {
			name: t('ob.markDoneNamed', { name: t('ob.signIn.title') })
		});
		await userEvent.click(mark);
		await canvas.findByText(t('ob.progress', { done: 1, total: CHECKLIST.length }));
		await canvas.findByRole('button', {
			name: t('ob.againNamed', { name: t('ob.signIn.title') })
		});
	}}
>
	{#snippet template()}
		<ChecklistHarness />
	{/snippet}
</Story>

<Story
	name="Checklist: an item already done in the environment is checked"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The second factor is in place (a probe says so): the item is checked without being done.
		await canvas.findByText(t('ob.progress', { done: 1, total: CHECKLIST.length }));
		await canvas.findByRole('button', {
			name: t('ob.againNamed', { name: t('ob.secondFactor.title') })
		});
		await expect(
			canvas.getByRole('button', {
				name: t('ob.startNamed', { name: t('ob.signIn.title') })
			})
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<ChecklistHarness probes={{ 'second-factor': async () => true }} />
	{/snippet}
</Story>

<Story name="Checklist: in progress, a guide running">
	{#snippet template()}
		<ChecklistHarness completed={['sign-in']} activeItemId="theme" />
	{/snippet}
</Story>

<Story
	name="Checklist: all done"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ob.allDone'));
	}}
>
	{#snippet template()}
		<ChecklistHarness completed={CHECKLIST.map((item) => item.id)} />
	{/snippet}
</Story>

<Story
	name="Checklist: progress not loaded"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('ob.loadFailed'));
	}}
>
	{#snippet template()}
		<ChecklistHarness fail />
	{/snippet}
</Story>

<Story
	name="Guide: on a phone the navigation step points at the menu button"
	play={async ({ canvasElement }) => {
		const pop = await popover(canvasElement);
		await expect(pop).toHaveTextContent(t('ob.theme.nav.body'));
		// The category is not drawn on a phone; the step says where it is, and points at the
		// button that opens it.
		await expect(pop).toHaveTextContent(t('ob.menu.action'));
		await waitFor(() => {
			const lit = canvasElement.ownerDocument.querySelector('.driver-active-element');
			expect(lit?.getAttribute('data-guide')).toBe('nav-menu');
		});
		await within(pop).findByRole('button', { name: t('ob.next') });
	}}
>
	{#snippet template()}
		<GuideHarness startAt={0} phone />
	{/snippet}
</Story>

<Story
	name="Guide: a step with Next"
	play={async ({ canvasElement }) => {
		const pop = await popover(canvasElement);
		await expect(pop).toHaveTextContent(t('ob.theme.s2.body'));
		await within(pop).findByRole('button', { name: t('ob.next') });
	}}
>
	{#snippet template()}
		<GuideHarness startAt={3} />
	{/snippet}
</Story>

<Story
	name="Guide: a step that waits for the person"
	play={async ({ canvasElement }) => {
		const pop = await popover(canvasElement);
		await expect(pop).toHaveTextContent(t('ob.theme.s5.action'));
		// It moves on when the person does it, so there is no Next.
		await expect(within(pop).queryByRole('button', { name: t('ob.next') })).toBeNull();
	}}
>
	{#snippet template()}
		<GuideHarness startAt={6} />
	{/snippet}
</Story>

<Story
	name="Guide: from the checklist to done, across pages"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const text = async (key: Parameters<typeof t>[0]) =>
			waitFor(async () => expect(await popover(canvasElement)).toHaveTextContent(t(key)));
		const next = async () =>
			userEvent.click(
				within(await popover(canvasElement)).getByRole('button', { name: t('ob.next') })
			);

		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('ob.startNamed', { name: t('ob.theme.title') })
			})
		);
		// It starts where the checklist is, saying where things are; Next leads to the themes page.
		await text('ob.theme.nav.body');
		await next();
		await text('ob.theme.sub.body');
		await next();
		// There it waits for a theme to be opened.
		await text('ob.theme.s1.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.list.create') }));
		await text('ob.theme.s2.body');
		await next();
		await text('ob.theme.s3.body');
		await next();
		await text('ob.theme.s4.action');
		await userEvent.click(canvas.getByRole('tab', { name: 'Images' }));
		await text('ob.theme.s5.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.bg.browse') }));
		await text('ob.theme.name.action');
		await next();
		await text('ob.theme.s6.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.page.save') }));
		await text('ob.theme.apply.action');
		await userEvent.click(canvas.getByRole('button', { name: t('th.action.apply') }));
		// Applied: the item is checked, and the guide offers the way back to the list.
		await text('ob.done.title');
		await userEvent.click(
			within(await popover(canvasElement)).getByRole('button', { name: t('ob.done.back') })
		);
		await canvas.findByText(t('ob.progress', { done: 1, total: 1 }));
	}}
>
	{#snippet template()}
		<GuideHarness />
	{/snippet}
</Story>

<Story
	name="Second factor: through the account menu, to the first one registered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const text = async (key: Parameters<typeof t>[0]) =>
			waitFor(async () => expect(await popover(canvasElement)).toHaveTextContent(t(key)));
		const next = async () =>
			userEvent.click(
				within(await popover(canvasElement)).getByRole('button', { name: t('ob.next') })
			);

		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('ob.startNamed', { name: t('ob.secondFactor.title') })
			})
		);
		// It points at the account icon and waits for it to be pressed, then at the menu's entry.
		await text('ob.secondFactor.menu.action');
		await userEvent.click(canvas.getByRole('button', { name: t('account.menu') }));
		await text('ob.secondFactor.settings.action');
		// The menu closes (a click elsewhere): it points at what opens it again.
		await userEvent.click(canvas.getByRole('button', { name: t('account.menu') }));
		// A target that is gone is waited for before the fallback is used (2.5 s).
		await waitFor(
			async () =>
				expect(await popover(canvasElement)).toHaveTextContent(
					t('ob.secondFactor.settings.fallback')
				),
			{ timeout: 5000 }
		);
		// Still waiting for the person: nothing to press but what it points at.
		await expect(
			within(await popover(canvasElement)).queryByRole('button', { name: t('ob.next') })
		).toBeNull();
		await userEvent.click(canvas.getByRole('button', { name: t('account.menu') }));
		await userEvent.click(await canvas.findByRole('link', { name: t('account.settings') }));
		// On personal settings: what a second factor is. Without an authenticator app on offer, the
		// plain wording; the add step waits for a registration.
		await text('ob.secondFactor.keys.body');
		await expect(await popover(canvasElement)).not.toHaveTextContent('TOTP');
		await next();
		await text('ob.secondFactor.add.action');
		await expect(await popover(canvasElement)).not.toHaveTextContent('TOTP');
		// The list of steps (outside the story's canvas, like the popover) is at the last step.
		const steps = within(
			canvasElement.ownerDocument.querySelector<HTMLElement>('aside.guide-steps') as HTMLElement
		);
		await expect(steps.getByText(t('ob.stepOf', { current: 4, total: 4 }))).toBeInTheDocument();
		await expect(steps.getAllByRole('listitem')).toHaveLength(4);
		await userEvent.click(canvas.getByRole('button', { name: t('sk.add') }));
		await text('ob.done.title');
	}}
>
	{#snippet template()}
		<SecondFactorHarness />
	{/snippet}
</Story>

<Story
	name="Second factor: says so where nothing can be registered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('ob.startNamed', { name: t('ob.secondFactor.title') })
			})
		);
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.secondFactor.menu.action'))
		);
		await userEvent.click(canvas.getByRole('button', { name: t('account.menu') }));
		await userEvent.click(await canvas.findByRole('link', { name: t('account.settings') }));
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.secondFactor.keys.bodyBlocked'))
		);
		await expect(await popover(canvasElement)).not.toHaveTextContent('TOTP');
		await userEvent.click(
			within(await popover(canvasElement)).getByRole('button', { name: t('ob.next') })
		);
		// No buttons to point at: the text is shown on its own (after the 2.5 s the guide waits for
		// its target), saying why, and that the item can be checked by hand.
		await waitFor(
			async () =>
				expect(await popover(canvasElement)).toHaveTextContent(
					t('ob.secondFactor.add.actionBlocked')
				),
			{ timeout: 5000 }
		);
		await expect(canvas.queryByRole('button', { name: t('sk.add') })).toBeNull();
	}}
>
	{#snippet template()}
		<SecondFactorHarness totp blocked />
	{/snippet}
</Story>

<Story
	name="Second factor: an authenticator app is named where it can be registered"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('ob.startNamed', { name: t('ob.secondFactor.title') })
			})
		);
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.secondFactor.menu.action'))
		);
		await userEvent.click(canvas.getByRole('button', { name: t('account.menu') }));
		await userEvent.click(await canvas.findByRole('link', { name: t('account.settings') }));
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.secondFactor.keys.bodyTotp'))
		);
		await userEvent.click(
			within(await popover(canvasElement)).getByRole('button', { name: t('ob.next') })
		);
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.secondFactor.add.bodyTotp'))
		);
		// Either kind finishes it.
		await userEvent.click(canvas.getByRole('button', { name: t('sk.addTotp') }));
		await waitFor(async () =>
			expect(await popover(canvasElement)).toHaveTextContent(t('ob.done.title'))
		);
	}}
>
	{#snippet template()}
		<SecondFactorHarness totp />
	{/snippet}
</Story>

<Story
	name="Steps of the running guide"
	play={async ({ canvasElement }) => {
		const panel = within(
			canvasElement.querySelector<HTMLElement>('aside.guide-steps') as HTMLElement
		);
		// Where the person is: the third of the item's steps; what is behind is checked off.
		await expect(
			panel.getByText(t('ob.stepOf', { current: 3, total: CHECKLIST[1].steps.length }))
		).toBeInTheDocument();
		const steps = panel.getAllByRole('listitem');
		await expect(steps).toHaveLength(CHECKLIST[1].steps.length);
		await expect(steps[2]).toHaveAttribute('aria-current', 'step');
		await expect(steps.filter((step) => step.classList.contains('step--done'))).toHaveLength(2);
		// Named by its short label, not by the sentence its popover is titled with.
		await expect(steps[0]).toHaveTextContent(t('ob.theme.nav.label'));
		await expect(steps[0]).not.toHaveTextContent(t('ob.theme.nav.title'));
		await expect(steps[3]).not.toHaveAttribute('aria-current');
		// Closing it ends the guide.
		await expect(
			panel.getByRole('button', { name: t('ob.stopNamed', { name: t('ob.theme.title') }) })
		).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<GuideSteps item={CHECKLIST[1]} index={2} onstop={() => {}} />
	{/snippet}
</Story>
