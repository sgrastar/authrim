<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Icon from './Icon.svelte';
	import { DIRECTIONAL_ICONS, ICON_PATHS, type IconName } from './icons';

	const { Story } = defineMeta({
		title: 'Tokens/Icons',
		component: Icon,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Phosphor Icons, Regular weight only. Icons marked “mirrors” point along the reading direction and flip in right-to-left languages (switch the toolbar to AR). Decorative by default; pass `label` when an icon carries meaning on its own.'
				}
			}
		}
	});
	const names = Object.keys(ICON_PATHS) as IconName[];
</script>

<Story name="Gallery">
	{#snippet template()}
		<ul
			style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px;margin:0;padding:0;list-style:none"
		>
			{#each names as name (name)}
				<li
					style="display:grid;justify-items:center;gap:6px;padding:12px 6px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg-card);font-size:11px;color:var(--text-secondary)"
				>
					<Icon {name} size={22} />
					<code>{name}</code>
					{#if DIRECTIONAL_ICONS.has(name)}<span>mirrors</span>{/if}
				</li>
			{/each}
		</ul>
	{/snippet}
</Story>
