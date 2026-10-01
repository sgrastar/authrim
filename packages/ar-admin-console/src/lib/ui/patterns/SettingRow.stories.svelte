<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import SaveModelDemo from '../stories/SaveModelDemo.svelte';
	import SettingRow from './SettingRow.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Setting row',
		component: SettingRow,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'One setting: what it is on the start side, its control on the end side. The control decides the save model — a Toggle applies at once; checkboxes and fields wait for the SaveBar.'
				}
			}
		}
	});
</script>

<Story name="Save model">
	{#snippet template()}<SaveModelDemo />{/snippet}
</Story>
