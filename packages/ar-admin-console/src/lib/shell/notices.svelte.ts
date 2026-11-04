/**
 * The header's inbox: loads the admin's open notices, keeps them fresh and hands them to the
 * notification area. A failed load keeps the last list and says nothing (the header must never
 * become the thing that complains); the Notifications page shows its own errors.
 *
 * Fresh means: on start, when the tenant changes, when the window gets focus again and every
 * two minutes while the page is visible.
 */
import { hasMessage, i18n, t } from '#lib/i18n/i18n.svelte.js';
import {
	noticeToShell,
	type AdminNotice,
	type AdminNoticesClient
} from '#lib/api/admin-notices.js';
import { timePreference } from '#lib/ui/time/time-preference.svelte.js';
import { SvelteSet } from 'svelte/reactivity';
import type { ShellNotification } from './notifications';

export const NOTICE_POLL_MS = 2 * 60_000;

export function createNoticeInbox(client: AdminNoticesClient, pollMs = NOTICE_POLL_MS) {
	let items = $state<AdminNotice[]>([]);
	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let listening = false;
	/** Bumped by a reset (a tenant change): work started before it must not write its list back. */
	let epoch = 0;
	/** Notices being dismissed: a list that arrives meanwhile must not bring them back. */
	const dismissing = new SvelteSet<string>();

	async function refresh(options: { reset?: boolean } = {}): Promise<void> {
		controller?.abort();
		const mine = new AbortController();
		controller = mine;
		if (options.reset) {
			epoch += 1;
			items = [];
		}
		try {
			const next = await client.list(mine.signal);
			if (controller === mine) {
				items = next.filter((item) => !dismissing.has(item.id));
				controller = null;
			}
		} catch {
			// Keep what is shown.
			if (controller === mine) controller = null;
		}
	}

	const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
	const onFocus = () => void refresh();
	const onVisibility = () => {
		if (visible()) {
			void refresh();
			startTimer();
		} else {
			stopTimer();
		}
	};

	function startTimer() {
		if (timer === null) timer = setInterval(() => void refresh(), pollMs);
	}
	function stopTimer() {
		if (timer !== null) clearInterval(timer);
		timer = null;
	}

	/** Starts the polling; the returned function stops it. */
	function start(): () => void {
		if (!listening && typeof window !== 'undefined') {
			listening = true;
			window.addEventListener('focus', onFocus);
			document.addEventListener('visibilitychange', onVisibility);
		}
		if (visible()) startTimer();
		return stop;
	}

	function stop() {
		stopTimer();
		controller?.abort();
		controller = null;
		if (listening && typeof window !== 'undefined') {
			window.removeEventListener('focus', onFocus);
			document.removeEventListener('visibilitychange', onVisibility);
		}
		listening = false;
	}

	/** Drops the answer of the list read in flight, if any. */
	function cancelRead() {
		controller?.abort();
		controller = null;
	}

	/** Dismisses information from the header's list; the list is read again if it fails. */
	async function dismiss(id: string): Promise<void> {
		const started = epoch;
		// A list read before this dismissal would bring the notice back: drop its answer.
		cancelRead();
		dismissing.add(id);
		items = items.filter((item) => item.id !== id);
		try {
			await client.dismiss(id);
		} catch {
			dismissing.delete(id);
			// Another tenant's list may be showing by now; this one is read again instead.
			if (epoch === started) await refresh();
			return;
		}
		// A list read while the dismissal was on its way may predate it: drop that answer, and read
		// again (it may be another tenant's first list), now that the server has the dismissal.
		const reading = controller !== null;
		cancelRead();
		dismissing.delete(id);
		items = items.filter((item) => item.id !== id);
		if (reading) await refresh();
	}

	return {
		get items(): readonly AdminNotice[] {
			return items;
		},
		get notifications(): ShellNotification[] {
			return items.map((notice) =>
				noticeToShell(notice, { t, hasMessage, locale: i18n.locale, zone: timePreference.zone })
			);
		},
		refresh,
		dismiss,
		start,
		stop
	};
}

export type NoticeInbox = ReturnType<typeof createNoticeInbox>;
