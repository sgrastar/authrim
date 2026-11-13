<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import StepConditionsFieldHarness from './StepConditionsFieldHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Step shown to',
		component: StepConditionsFieldHarness,
		tags: ['autodocs', 'draft'],
		parameters: {
			docs: {
				description: {
					component:
						'Who a step of a sign-up or sign-in flow is shown to (a more screen, a consent step). No rule: everyone. Rules must all hold, so “all of these” is said, not chosen: people who meet any one of several go in steps of their own. A rule compares an attribute of the person (the standard profile ones, then the tenant’s own from its Identity Schema, each compared as its type allows), their age in whole years, a choice made on one of the flow’s screens before the step (a part kept off the profile and sent to the Flow), the app they came from, or the language the screens are shown in. A rule still being written is kept, and the flow cannot be saved until it is finished or removed. A list that cannot be read is told in the field; the rules are not changed until the tenant’s attributes are read.'
				}
			}
		}
	});
</script>

<!-- Everyone, until a rule is added; a rule is saved as the condition the Flow runs. -->
<Story
	name="Adding a rule"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// The rules are drawn once the tenant's attributes are read.
		await expect(await canvas.findByText(t('af.when.everyone'))).toBeInTheDocument();
		await expect(canvas.getByTestId('when')).toHaveTextContent('[]');
		await userEvent.click(canvas.getByRole('button', { name: t('cond.addRule') }));
		await userEvent.click(await body.findByRole('option', { name: t('af.when.source.age') }));
		const age = canvas.getAllByRole('textbox').at(-1) as HTMLElement;
		await expect(canvas.getByTestId('incomplete')).toHaveTextContent('incomplete');
		await userEvent.click(age);
		await userEvent.type(age, '18');
		await waitFor(() =>
			expect(canvas.getByTestId('when')).toHaveTextContent(
				'[{"type":"user.age","operator":"gte","value":18}]'
			)
		);
		await expect(canvas.getByTestId('incomplete')).toHaveTextContent('complete');
	}}
></Story>

<!-- A step for people from abroad who signed up in English, and answered the survey before. -->
<Story
	name="Several rules"
	args={{
		answerScreens: ['welcome_survey'],
		initial: [
			JSON.stringify({
				id: 'a',
				field: 'attribute:address.country',
				operator: 'not_in',
				value: ['JP']
			}),
			JSON.stringify({ id: 'b', field: 'locale', operator: 'eq', value: 'en' }),
			JSON.stringify({ id: 'c', field: 'answer:heard_from', operator: 'exists', value: null })
		]
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('cond.match.all'))).toBeInTheDocument();
		await expect(canvas.queryByText(t('af.when.everyone'))).toBeNull();
		await expect(canvas.getByTestId('incomplete')).toHaveTextContent('complete');
	}}
></Story>

<!-- An age the Flow cannot compare: said in the rule, and the flow is not saved with it. -->
<Story
	name="A rule that cannot be saved"
	args={{
		initial: [JSON.stringify({ id: 'a', field: 'age', operator: 'gte', value: 200 })]
	}}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('cond.problem.invalidValue'))).toBeInTheDocument();
		await expect(canvas.getByTestId('incomplete')).toHaveTextContent('incomplete');
	}}
></Story>

<!--
	The tenant's attributes cannot be read: the rules are not changed until they are (a rule on an
	attribute is checked by its type), and what was saved stays as it is.
-->
<Story
	name="Attributes not loaded"
	args={{ attributesFail: true }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.when.attributesFailed'))).toBeInTheDocument();
		await expect(canvas.queryByRole('button', { name: t('cond.addRule') })).toBeNull();
		await expect(canvas.getByRole('button', { name: t('common.retry') })).toBeInTheDocument();
	}}
></Story>
