<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { sample } from '../stories/sample';
	import { named, subcomponents } from '../stories/subcomponents';
	import Badge from './Badge.svelte';
	import CountBadge from './CountBadge.svelte';
	import RequiredBadge from './RequiredBadge.svelte';
	import TypeBadge from './TypeBadge.svelte';

	// The props table's main tab (see named()).
	named(Badge, 'Badge');

	const { Story } = defineMeta({
		title: 'Primitives/Badge',
		component: Badge,
		tags: ['autodocs'],
		subcomponents: subcomponents({ TypeBadge, RequiredBadge, CountBadge }),
		parameters: {
			docs: {
				description: {
					component:
						'Every small label on an item, told apart by how heavy it looks:\n\n- **Badge** — a status (tinted): enabled / disabled in lists; the other tones for what needs attention; `changed` for “changed, not saved yet”.\n- **TypeBadge** — a data type or short fact (filled, quiet, left to right): `string`, `boolean`.\n- **RequiredBadge** — required as a property of an item in a list (outlined, no colour). A form field the admin must fill uses a red “*” on its label instead.\n- **CountBadge** — how many things wait, next to a navigation entry (the danger colour: it asks for action).\n\nOrder after a name: type, then required, then status.'
				}
			}
		}
	});
</script>

<Story name="Status">
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:8px">
			<Badge tone="success" dot>{sample('enabled')}</Badge>
			<Badge dot>{sample('disabled')}</Badge>
			<Badge tone="warning">{sample('missing')}</Badge>
			<Badge tone="danger">{sample('failed')}</Badge>
			<Badge tone="info">{sample('preview')}</Badge>
			<Badge tone="changed">{t('common.changed')}</Badge>
		</div>
	{/snippet}
</Story>

<Story name="Type">
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:8px">
			<TypeBadge>string</TypeBadge>
			<TypeBadge>boolean</TypeBadge>
			<TypeBadge>string[]</TypeBadge>
			<TypeBadge muted>number</TypeBadge>
			<TypeBadge size="sm">date</TypeBadge>
			<TypeBadge size="sm">number</TypeBadge>
		</div>
	{/snippet}
</Story>

<Story name="Required">
	{#snippet template()}
		<RequiredBadge />
	{/snippet}
</Story>

<Story name="Count">
	{#snippet template()}
		<div style="display:flex;gap:8px">
			<CountBadge value={3} />
			<CountBadge value="99+" />
		</div>
	{/snippet}
</Story>

<Story
	name="Together in a row"
	play={async ({ canvasElement }) => {
		const row = within(canvasElement);
		await expect(row.getByText('string')).toBeVisible();
		await expect(row.getByText(t('common.required'))).toBeVisible();
	}}
>
	{#snippet template()}
		<div style="display:flex;align-items:center;gap:8px;font-size:var(--fs-body)">
			<code style="font-weight:var(--fw-semibold)">email</code>
			<TypeBadge>string</TypeBadge>
			<RequiredBadge />
			<Badge tone="success" dot>{sample('enabled')}</Badge>
		</div>
	{/snippet}
</Story>
