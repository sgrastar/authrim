<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import EnvironmentBanner from './EnvironmentBanner.svelte';

	const { Story } = defineMeta({
		title: 'Shell/Environment banner',
		component: EnvironmentBanner,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'The platform’s environment notice: a flat full-width band in the app shell’s `banner` slot, with no coloured edge (warning tone for its fill, outline and text). Plain text only, from the session answer: the language’s own text, else the general one; nothing is drawn while there is none. A notice, not a security control. Use the language and theme toolbars to see it in Arabic (right to left) and in each theme.'
				}
			}
		}
	});
</script>

<Story
	name="Short text"
	args={{ text: 'This is the staging environment.' }}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText('This is the staging environment.')).toBeVisible();
	}}
/>

<Story
	name="Long text wraps"
	args={{
		text: 'This is the staging environment used to rehearse upgrades before they reach production. Accounts, applications and settings created here are not copied anywhere, and the whole environment may be rebuilt without notice.'
	}}
/>

<Story
	name="Text in the console’s language"
	args={{
		text: 'This is the staging environment.',
		textLocalizations: {
			ja: 'ステージング環境です。',
			de: 'Dies ist die Staging-Umgebung.',
			ar: 'هذه بيئة الاختبار.'
		}
	}}
/>

<Story
	name="Nothing to show"
	args={{ text: '', textLocalizations: {} }}
	play={async ({ canvasElement }) => {
		await expect(within(canvasElement).queryByRole('region')).toBeNull();
	}}
/>
