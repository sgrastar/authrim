<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import ChoiceCards from './ChoiceCards.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Choice cards',
		component: ChoiceCards,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'One choice among a few that each need a sentence to tell apart: where to connect, what kind of app. Native radios underneath, so the arrow keys move the choice and a screen reader hears a radio group. The chosen card is ringed all round in the main colour (no coloured edge). For a plain list of short options use RadioGroup; for several at once, CheckboxGroup.'
				}
			}
		}
	});

	const where = [
		{
			value: 'out',
			label: 'Let an app or service sign in through Authrim',
			description:
				'Authrim is the identity provider. An app or a service sends its people here to sign in.',
			icon: 'arrowOut' as const
		},
		{
			value: 'in',
			label: 'Let people sign in through another provider',
			description:
				'Authrim is the relying party. People sign in with another provider, and Authrim trusts the result.',
			icon: 'arrowIn' as const
		}
	];
</script>

<Story
	name="Two ways"
	args={{ label: 'Where do you want to connect?', options: where, columns: 1 }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const first = canvas.getByRole('radio', { name: /^Let an app or service/ });
		await userEvent.click(first);
		await expect(first).toBeChecked();
		// The arrow keys move the choice, as in any radio group.
		await userEvent.keyboard('{ArrowDown}');
		await expect(canvas.getByRole('radio', { name: /^Let people sign in/ })).toBeChecked();
	}}
/>

<Story
	name="Three in a row"
	args={{
		label: 'What kind of app?',
		columns: 3,
		value: 'spa',
		options: [
			{ value: 'web', label: 'Web app', description: 'Keeps a secret on a server.', icon: 'globe' },
			{ value: 'spa', label: 'Single-page app', description: 'Runs in the browser.', icon: 'app' },
			{
				value: 'native',
				label: 'Native app',
				description: 'Installed on a device.',
				icon: 'deviceMobile'
			}
		]
	}}
/>

<Story
	name="One not available yet"
	args={{
		label: 'What do you want to connect?',
		options: [
			{
				value: 'oidc',
				label: 'An app that uses OpenID Connect',
				description: 'A web, single-page or native app.',
				icon: 'app'
			},
			{
				value: 'saml',
				label: 'A service that uses SAML',
				description: 'A publisher or another service.',
				icon: 'handshake'
			},
			{
				value: 'api',
				label: 'A server calling an API',
				description: 'No people involved.',
				icon: 'plug',
				badge: 'Later',
				disabled: true
			}
		]
	}}
/>
