<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { createFakeOnboarding } from '#lib/api/fake/onboarding-fake.js';
	import { httpOnboarding } from '#lib/api/onboarding.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import OnboardingChecklist from './OnboardingChecklist.svelte';
	import { onboardingProgress } from './progress.svelte';

	/** Storybook only: the checklist over an in-memory API, with no guide behind its buttons. */
	interface Props {
		completed?: readonly string[];
		activeItemId?: string | null;
		/** The progress cannot be read. */
		fail?: boolean;
	}

	let { completed = [], activeItemId = null, fail = false }: Props = $props();

	$effect(() =>
		untrack(() => {
			onboardingProgress.use(createFakeOnboarding(completed, { fail }));
			void onboardingProgress.load();
		})
	);

	onDestroy(() => onboardingProgress.use(httpOnboarding));
</script>

<Page>
	<OnboardingChecklist {activeItemId} onstart={() => {}} onstop={() => {}} />
</Page>
