<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import Link from './Link.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Link',
		component: Link,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Same-tab links move within the console. `newTab` opens outside it: external mark (mirrored in RTL), `rel="noopener noreferrer"`, and a screen-reader note that it opens a new tab. `standalone` for a link on its own line.'
				}
			}
		}
	});
</script>

<Story name="Same tab and new tab">
	{#snippet template()}
		<div style="display:grid;gap:14px;font-size:13.5px">
			<p style="margin:0">
				{sample('linkSentence1')}
				<Link href="https://authrim.com/docs/saml" newTab>{sample('docsLink')}</Link>
				{sample('linkSentence2')}
			</p>
			<div style="display:flex;flex-wrap:wrap;gap:20px">
				<Link href="/admin/monitoring/audit" standalone>{sample('auditLink')}</Link>
				<Link href="https://authrim.com/docs" newTab standalone>{sample('docs')}</Link>
			</div>
			<ul
				style="margin:0;padding:0;list-style:none;display:grid;gap:6px;color:var(--text-muted);font-size:12px"
			>
				<li><Link href="/admin" quiet>{sample('sameTab')}</Link></li>
				<li><Link href="https://example.com" newTab quiet>{sample('newTabLabel')}</Link></li>
			</ul>
		</div>
	{/snippet}
</Story>
