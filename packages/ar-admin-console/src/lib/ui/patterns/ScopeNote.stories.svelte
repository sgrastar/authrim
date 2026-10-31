<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { t } from '$lib/i18n/i18n.svelte';
	import ScopeNote from './ScopeNote.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Scope note',
		component: ScopeNote,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Top of a page in platform scope: what this item does here — sets every tenant’s default, searches across tenants, cannot be set here, or shares a definition.'
				}
			}
		}
	});

	const KINDS = ['inherit', 'lookup', 'tenant', 'template'] as const;
</script>

<Story name="Kinds">
	{#snippet template()}
		<div style="display:grid;gap:10px">
			{#each KINDS as kind (kind)}
				<ScopeNote
					{kind}
					title={t(`plat.${kind}.title`)}
					body={t(`plat.${kind}.body`)}
					pill={t(`plat.${kind}.pill`)}
				/>
			{/each}
		</div>
	{/snippet}
</Story>
