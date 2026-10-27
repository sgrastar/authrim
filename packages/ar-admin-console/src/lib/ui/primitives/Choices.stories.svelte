<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import RadioGroup from './RadioGroup.svelte';
	import SegmentedControl from './SegmentedControl.svelte';
	import Select from './Select.svelte';
	import SelectMenu from './SelectMenu.svelte';

	// The props table's main tab (see named()).
	named(RadioGroup, 'RadioGroup');

	const { Story } = defineMeta({
		title: 'Primitives/Choices',
		component: RadioGroup,
		subcomponents: subcomponents({ Select, SelectMenu, SegmentedControl }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Use **RadioGroup** for up to five visible choices, **Select** for longer lists, and **SegmentedControl** for short view or time switches. In a settings card, place the group in a **FieldRow**. Keep the short MFA consequences below each option because they distinguish the choices; put optional detail in an `info` tip. Use **SelectMenu** when a choice needs an icon or badge.'
				}
			}
		}
	});

	const mfa = () => [
		{ value: 'off', label: sample('mfaOff'), description: sample('mfaOffDesc') },
		{ value: 'risk', label: sample('mfaRisk'), description: sample('mfaRiskDesc') },
		{ value: 'always', label: sample('mfaAlways'), description: sample('mfaAlwaysDesc') }
	];
	const attributes = [
		{ key: 'given_name', type: 'String' },
		{ key: 'family_name', type: 'String' },
		{ key: 'birthdate', type: 'Date' },
		{ key: 'birth_year', type: 'Number' },
		{ key: 'news_opt_in', type: 'Boolean' }
	].map(({ key, type }) => ({
		value: key,
		label: key,
		badge: type,
		mono: true,
		// A type that does not fit stays listed, disabled, and is skipped by the keys.
		disabled: type === 'Boolean'
	}));
	const methods = () => [
		{
			value: 'off',
			label: sample('mfaOff'),
			description: sample('mfaOffDesc'),
			icon: 'password' as const,
			group: sample('groupBasic')
		},
		{
			value: 'risk',
			label: sample('mfaRisk'),
			description: sample('mfaRiskDesc'),
			icon: 'shieldCheck' as const,
			group: sample('groupStronger')
		},
		{
			value: 'always',
			label: sample('mfaAlways'),
			description: sample('mfaAlwaysDesc'),
			icon: 'deviceMobile' as const,
			group: sample('groupStronger')
		}
	];
	const regions = () => [
		{ value: 'jp', label: sample('regionJp') },
		{ value: 'eu', label: sample('regionEu') },
		{ value: 'us', label: sample('regionUs') },
		{ value: 'apac', label: sample('regionApac'), disabled: true }
	];
</script>

<Story name="Radio group">
	{#snippet template()}<RadioGroup
			label={sample('mfaMode')}
			options={mfa()}
			value="risk"
		/>{/snippet}
</Story>

<Story name="Radio group (horizontal)">
	{#snippet template()}
		<RadioGroup
			label={sample('period')}
			orientation="horizontal"
			value="week"
			options={[
				{ value: 'day', label: sample('day') },
				{ value: 'week', label: sample('week') },
				{ value: 'month', label: sample('month') }
			]}
		/>
	{/snippet}
</Story>

<Story name="Select">
	{#snippet template()}
		<div style="display:grid;gap:14px;max-width:320px">
			<Select label={sample('region')} options={regions()} value="jp" hint={sample('regionHint')} />
			<Select label={sample('region')} options={regions()} placeholder required />
		</div>
	{/snippet}
</Story>

<Story
	name="Segmented (button type)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const month = canvas.getByRole('radio', { name: sample('month') });
		await userEvent.click(month);
		await expect(month).toBeChecked();
	}}
>
	{#snippet template()}
		<div style="display:grid;gap:14px;justify-items:start">
			<SegmentedControl
				label={sample('period')}
				value="week"
				options={[
					{ value: 'day', label: sample('day') },
					{ value: 'week', label: sample('week') },
					{ value: 'month', label: sample('month') }
				]}
			/>
			<SegmentedControl
				label={sample('viewMode')}
				size="sm"
				value="list"
				options={[
					{ value: 'list', label: sample('viewList'), icon: 'list' },
					{ value: 'flow', label: sample('viewFlow'), icon: 'plug' }
				]}
			/>
		</div>
	{/snippet}
</Story>

<Story
	name="Select menu (badges)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('combobox');
		box.focus();
		// ↓ opens on the chosen row; ↓ ↓ Enter chooses two rows further.
		await userEvent.keyboard('{ArrowDown}');
		await expect(box).toHaveAttribute('aria-expanded', 'true');
		await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
		await expect(box).toHaveAttribute('aria-expanded', 'false');
		await expect(box).toHaveTextContent('birth_year');
		// Typing jumps to the matching row; disabled rows are skipped.
		await userEvent.keyboard('{ArrowDown}f{Enter}');
		await expect(box).toHaveTextContent('family_name');
		await userEvent.keyboard('{ArrowDown}{End}{Enter}');
		await expect(box).toHaveTextContent('birth_year');
	}}
>
	{#snippet template()}
		<div style="max-width:320px">
			<SelectMenu label={sample('storedIn')} options={attributes} value="family_name" />
		</div>
	{/snippet}
</Story>

<Story name="Select menu (icons, groups)">
	{#snippet template()}
		<div style="max-width:360px">
			<SelectMenu label={sample('mfaMode')} options={methods()} value="risk" />
		</div>
	{/snippet}
</Story>

<Story
	name="Select menu (cascade)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const box = canvas.getByRole('combobox');
		box.focus();
		// Opens on the chosen option, its group's options beside the headings.
		await userEvent.keyboard('{ArrowDown}');
		const current = document.getElementById(box.getAttribute('aria-activedescendant') ?? '');
		await expect(current).toHaveTextContent(sample('mfaRisk'));
		await expect(current?.closest('[popover]')?.matches(':popover-open')).toBe(true);
		// ↑ walks into the group above, which opens in turn.
		await userEvent.keyboard('{ArrowUp}{Enter}');
		await expect(box).toHaveTextContent(sample('mfaOff'));
	}}
>
	{#snippet template()}
		<div style="max-width:260px">
			<SelectMenu label={sample('mfaMode')} options={methods()} value="risk" cascade />
		</div>
	{/snippet}
</Story>
