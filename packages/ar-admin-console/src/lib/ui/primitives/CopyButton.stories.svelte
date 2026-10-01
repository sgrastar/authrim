<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import CopyButton from './CopyButton.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Copy button',
		component: CopyButton,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Copies text to the clipboard and confirms it for two seconds (also announced to screen readers). Use the icon variant next to identifiers and secrets; the labelled variant above blocks of code.'
				}
			}
		}
	});
</script>

<Story name="Variants">
	{#snippet template()}
		<div style="display:grid;gap:14px;justify-items:start">
			<CopyButton text="acme-portal" />
			<div style="display:flex;align-items:center;gap:8px;font-size:13px">
				<span style="color:var(--text-muted)">{sample('clientId')}</span>
				<code style="font-family:var(--font-mono)">acme-portal</code>
				<CopyButton text="acme-portal" variant="icon" label={sample('clientId')} />
			</div>
		</div>
	{/snippet}
</Story>
