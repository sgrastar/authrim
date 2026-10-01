<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import ColumnSpan from './ColumnSpan.svelte';
	import Badge from '../primitives/Badge.svelte';
	import { sample } from '../stories/sample';
	import DateTime from '../time/DateTime.svelte';
	import Card from './Card.svelte';
	import Columns from './Columns.svelte';
	import DetailItem from './DetailItem.svelte';
	import DetailList from './DetailList.svelte';
	import PermissionsDemo from '../stories/PermissionsDemo.svelte';
	import UserInfoFormDemo from '../stories/UserInfoFormDemo.svelte';

	// The props table's main tab (see named()).
	named(Columns, 'Columns');

	const { Story } = defineMeta({
		title: 'Patterns/Columns',
		component: Columns,
		subcomponents: subcomponents({ ColumnSpan }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Two or three columns for forms, facts and cards. The column count follows the room the block really has — the page next to the left nav, a card, a dialog — not the screen: when a column would get narrower than `minWidth`, one column goes, down to one on phones. Children fill in reading order (row by row); `ColumnSpan` gives one the whole row.\n\nFor facts, `DetailList columns={2|3}` does the same with each label above its value. Keep related fields next to each other (given and family name), and do not use three columns for fields that take long values.'
				}
			}
		}
	});
</script>

<Story name="Form, two columns">
	{#snippet template()}<UserInfoFormDemo />{/snippet}
</Story>

<Story name="Form, three columns">
	{#snippet template()}<UserInfoFormDemo columns={3} />{/snippet}
</Story>

<Story name="Facts in columns">
	{#snippet template()}
		<div style="display:grid;gap:16px">
			<Card title={sample('accountInfo')}>
				<DetailList columns={3}>
					<DetailItem label={sample('userId')}>2poWRxkpN9Ki9xX3Wb0Zf</DetailItem>
					<DetailItem label={sample('state')}
						><Badge tone="success" dot>{sample('enabled')}</Badge></DetailItem
					>
					<DetailItem label={sample('emailVerified')}>{sample('yes')}</DetailItem>
					<DetailItem label={sample('createdAt')}
						><DateTime value="2026-02-06T00:00:00Z" /></DetailItem
					>
					<DetailItem label={sample('lastSignInAt')}
						><DateTime value="2026-09-25T19:00:00Z" /></DetailItem
					>
					<DetailItem label={sample('fieldPhone')}>+81 90 1234 5678</DetailItem>
				</DetailList>
			</Card>
			<Card title={sample('accountInfo')}>
				<DetailList columns={2}>
					<DetailItem label={sample('userId')}>2poWRxkpN9Ki9xX3Wb0Zf</DetailItem>
					<DetailItem label={sample('state')}
						><Badge tone="success" dot>{sample('enabled')}</Badge></DetailItem
					>
					<DetailItem label={sample('createdAt')}
						><DateTime value="2026-02-06T00:00:00Z" /></DetailItem
					>
					<DetailItem label={sample('lastSignInAt')}
						><DateTime value="2026-09-25T19:00:00Z" /></DetailItem
					>
				</DetailList>
			</Card>
		</div>
	{/snippet}
</Story>

<Story name="Permission groups">
	{#snippet template()}<PermissionsDemo />{/snippet}
</Story>
