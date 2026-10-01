<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import DestinationProfileDemo from '../stories/DestinationProfileDemo.svelte';
	import SourceProfileDemo from '../stories/SourceProfileDemo.svelte';
	import MappingEditor from './MappingEditor.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Attribute mapping',
		component: MappingEditor,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Which attribute fills which, read left to right as the data flows. Transforms can be chained and reordered (from each step’s “⋯” menu): before “Combine attributes” they apply to each source attribute, after it to the combined value.\n\n- **Inbound** (`direction="inbound"`): the source — an IdP, a directory — on the left, Authrim’s attributes on the right.\n- **Outbound** (`direction="outbound"`): Authrim’s attributes on the left, the destination — an RP, an SP — on the right.\n\nEvery attribute on the receiving side is listed, one line each (“mail (lower case) → email”), so what is set and what is still empty shows at a glance; a count and a filter (all / not set / needs attention) help with long lists. Press a line to edit it in place: the source attribute(s) on the left; on the right the transforms drawn as the way the value goes, each with its settings and a “⋯” menu to run it earlier or later or remove it, and a dotted place to add the next. A problem comes with the fix to apply (“Use the first value”, “Convert to yes or no”).'
				}
			}
		}
	});
</script>

<Story
	name="Inbound (into Authrim)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// A required attribute still unset: open its line, pick a source, apply the fix offered.
		await userEvent.click(canvas.getByRole('button', { name: /^enabled \(/ }));
		const option = await within(canvasElement.ownerDocument.body).findByRole('option', {
			name: /accountEnabled/
		});
		await userEvent.click(option);
		const fix = await canvas.findByRole('button', { name: t('map.fix.bool') });
		await userEvent.click(fix);
		await waitFor(() =>
			expect(canvas.queryByRole('button', { name: t('map.fix.bool') })).toBeNull()
		);
		// Taking away the only source attribute removes the mapping and closes the line
		// (the columns draw back first, then it folds).
		await userEvent.click(canvas.getByRole('button', { name: t('map.unassign') }));
		const line = canvas.getByRole('button', { name: /^enabled \(/ });
		await waitFor(() => expect(line).toHaveFocus());
		await waitFor(() => expect(line).toHaveAttribute('aria-expanded', 'false'));
		// With no source, a step can fill it with a fixed value: true, for a boolean.
		await userEvent.click(line);
		await userEvent.keyboard('{Escape}');
		await userEvent.click(canvas.getByRole('button', { name: t('map.addStep') }));
		// With no source, the picker opens on the values a step makes.
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await userEvent.click(
			picker.getByRole('button', { name: new RegExp(`^${t('map.t.constant_boolean')}`) })
		);
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
		await waitFor(() =>
			expect(line.getAttribute('aria-label')).toContain(t('map.s.fixed', { value: 'true' }))
		);
	}}
>
	{#snippet template()}<SourceProfileDemo />{/snippet}
</Story>

<Story
	name="Outbound (to an app)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Groups into a single-value attribute: the line says so and offers the fixes.
		await userEvent.click(canvas.getByRole('button', { name: /^costCenter[:：]/ }));
		await userEvent.click(await canvas.findByRole('button', { name: t('map.fix.first') }));
		await waitFor(() =>
			expect(canvas.queryByRole('button', { name: t('map.fix.first') })).toBeNull()
		);
		// Transforms run in order: add one to "mail", then run it first.
		await userEvent.click(canvas.getByRole('button', { name: /^mail \(/ }));
		await userEvent.click(await canvas.findByRole('button', { name: t('map.addStep') }));
		// The picker: look at a step, then add it with the preview's button.
		const picker = within(await canvas.findByRole('dialog', { name: t('map.pickStep') }));
		await userEvent.click(picker.getByRole('button', { name: new RegExp(`^${t('map.t.trim')}`) }));
		await userEvent.click(await picker.findByRole('button', { name: t('map.pick.add') }));
		await userEvent.click(canvas.getByRole('button', { name: t('map.stepMenu', { n: 2 }) }));
		await userEvent.click(await canvas.findByRole('menuitem', { name: t('map.runEarlier') }));
		const summary = canvas.getByRole('button', { name: /^mail \(/ });
		await waitFor(() =>
			expect(summary.querySelector('.mrow__transform')?.textContent).toBe(
				`${t('map.t.trim')}${t('map.stepsSep')}${t('map.s.lower')}`
			)
		);
	}}
>
	{#snippet template()}<DestinationProfileDemo />{/snippet}
</Story>
