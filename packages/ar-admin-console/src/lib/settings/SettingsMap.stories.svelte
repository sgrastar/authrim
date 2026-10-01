<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import SettingsMap from './SettingsMap.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings map',
		component: SettingsMap,
		parameters: {
			docs: {
				description: {
					component:
						'The settings inventory, for review: every Settings API setting, the page and section it lives on, and how deep (primary, advanced, search, hidden). Built pages come from `placement.ts`; the rest is the draft in `inventory.ts`. Duplicates and judgement calls carry a note; settings a saved value does not change yet are marked (`effect.ts`). Each page also lists the other Admin APIs it uses — dedicated settings APIs, records, actions and logs — grouped in `api-inventory.ts` from the operations generated into `api-operations.ts`. One header category shows at a time (pick it, or follow a link in the navigation overview); a search looks through every category. Filter by depth, effect or kind of entry, or search a key or an API path.'
				}
			}
		}
	});
</script>

<Story
	name="Settings map"
	play={async ({ canvasElement }) => {
		// Every setting has a place: nothing is listed as not placed.
		expect(within(canvasElement).queryByText('Not placed')).toBeNull();
	}}
>
	{#snippet template()}<SettingsMap />{/snippet}
</Story>
