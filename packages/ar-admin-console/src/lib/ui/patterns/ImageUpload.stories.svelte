<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import { Draft } from '../save/draft.svelte';
	import SaveScope from '../save/SaveScope.svelte';
	import Card from './Card.svelte';
	import ImageUpload from './ImageUpload.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Image upload',
		component: ImageUpload,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Single image with a thumbnail (logo, favicon, background). `value` is the stored image URL, a newly chosen File, or null; the preview is a local object URL released when the image changes, and a checkerboard keeps transparent edges visible. Inside a SaveScope (give it `field`), a new or removed image is marked and brings up the save bar — the image is uploaded only when the page saves.'
				}
			}
		}
	});

	// A small SVG logo so the story has a "current image" without a network request.
	const LOGO =
		'data:image/svg+xml;utf8,' +
		encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect x="10" y="10" width="100" height="100" rx="24" fill="#2c2724"/><path d="M60 30l8 22 22 8-22 8-8 22-8-22-22-8 22-8z" fill="#fff"/></svg>'
		);

	const branding = new Draft<{ logo: string | File | null }>({ logo: LOGO });
	const save = () => new Promise((resolve) => setTimeout(resolve, 900)).then(() => {});
</script>

<Story name="Empty">
	{#snippet template()}
		<div style="max-width:520px">
			<ImageUpload label={sample('logo')} maxBytes={1024 * 1024} />
		</div>
	{/snippet}
</Story>

<Story name="With current image">
	{#snippet template()}
		<div style="max-width:520px">
			<ImageUpload label={sample('logo')} value={LOGO} maxBytes={1024 * 1024} />
		</div>
	{/snippet}
</Story>

<Story name="Wide (background)">
	{#snippet template()}
		<div style="max-width:520px">
			<ImageUpload
				label={sample('background')}
				shape="wide"
				accept="image/png,image/jpeg,image/webp"
			/>
		</div>
	{/snippet}
</Story>

<Story name="In a settings page">
	{#snippet template()}
		<div style="max-width:620px">
			<SaveScope draft={branding} onsave={save}>
				<Card title={sample('logo')}>
					<ImageUpload
						field="logo"
						label={sample('logo')}
						maxBytes={1024 * 1024}
						bind:value={branding.value.logo}
					/>
				</Card>
			</SaveScope>
		</div>
	{/snippet}
</Story>
