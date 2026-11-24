<script lang="ts">
	import 'driver.js/dist/driver.css';
	import './guide.css';
	import { untrack } from 'svelte';
	import { afterNavigate, goto } from '$app/navigation';
	import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
	import { i18n, t } from '#lib/i18n/i18n.svelte.js';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import ConnectedGuideSteps from './ConnectedGuideSteps.svelte';
	import { guide } from './guide.svelte';
	import { saveFailedKey } from './progress.svelte';
	import { onGuideSignal } from './signals';

	/**
	 * Runs the first-steps guides for the whole console: placed once in the console's layout, it
	 * shows the step that belongs to the page after every navigation (and after a reload), hears
	 * what pages report, and ends the guide when the tenant changes. Driver.js draws the popover;
	 * the list of the guide's steps, at the bottom start, is drawn here.
	 */
	interface Props {
		/** Where the checklist is. */
		home?: string;
	}

	let { home = '/admin' }: Props = $props();

	$effect(() => {
		const target = home;
		return untrack(() => {
			const disconnect = guide.connect({
				pathname: () => window.location.pathname,
				goto: (path) => goto(path),
				home: target,
				onsavefailed: () => toast.error(t(saveFailedKey()))
			});
			const unlisten = onGuideSignal((signal) => guide.signal(signal));
			return () => {
				unlisten();
				disconnect();
			};
		});
	});

	afterNavigate(() => guide.refresh());

	// The popover's text is set when a step is shown: show it again in the new language.
	let locale = i18n.locale;
	$effect(() => {
		if (i18n.locale === locale) return;
		locale = i18n.locale;
		untrack(() => guide.refresh());
	});

	// A guide belongs to the tenant it was started in.
	let tenant = tenantScope.tenantId;
	$effect(() => {
		if (tenantScope.tenantId === tenant) return;
		tenant = tenantScope.tenantId;
		untrack(() => guide.stop());
	});
</script>

<ConnectedGuideSteps />
