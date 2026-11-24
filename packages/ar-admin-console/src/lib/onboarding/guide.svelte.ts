/**
 * The guide: walks one checklist item's steps, pointing at things on the page with Driver.js.
 *
 * It shows one step at a time and keeps where it is in the session, so it goes on across pages
 * and reloads. The page stays usable throughout: the person does the real thing, and the guide
 * follows (a click, a page they opened, a save a page reports). When they wander off, it hides
 * and comes back on the pages its steps are on.
 */
import type { Config, Driver } from 'driver.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { motionReduced } from '#lib/shell/motion.js';
import { CHECKLIST, type ChecklistItem, type GuideStep } from './checklist';
import {
	canGoBack,
	escapeHtml,
	isConcretePath,
	locateStep,
	matchesPath,
	moveOn,
	moveOnSignal,
	waitsForPerson,
	wordingOf,
	type Move
} from './guide-model';
import { onboardingProgress } from './progress.svelte';
import { guideFact, onGuideFactChange, type GuideSignal } from './signals';

interface Active {
	itemId: string;
	index: number;
}

export interface GuideHost {
	/** The console's current path. */
	pathname(): string;
	goto(path: string): void | Promise<void>;
	/** Where the checklist is: where "back to the list" leads. */
	home: string;
	/** Told when an item's progress could not be saved. */
	onsavefailed?(): void;
}

const STORAGE_KEY = 'authrim-console-guide';
/** How far the rest of the page is dimmed while a step points at something. */
const DIM = 0.45;
/** How long a step waits for what it points at before showing its text without it. */
const TARGET_WAIT_MS = 2500;

let items: readonly ChecklistItem[] = CHECKLIST;
let active = $state<Active | null>(null);
/** The item that was just finished, while its "done" popover is up (also across a navigation). */
let finished: ChecklistItem | null = null;
let host: GuideHost | null = null;
let driver: Driver | null = null;
/** Each render gets a number; a render that is no longer the latest stops. */
let generation = 0;
/** Changes when a guide is started or stopped: what an earlier one still awaits is dropped. */
let run = 0;
/** The step shown last, to tell arriving at a step from coming back to it. */
let shown = -1;
/** Set while the guide itself takes the popover down, to tell it from the person closing it. */
let closing = false;
let cleanup: (() => void) | null = null;

const itemOf = (id: string) => items.find((item) => item.id === id) ?? null;

function remember(): void {
	try {
		if (active) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(active));
		else sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Storage blocked: the guide lasts for this page only.
	}
}

function recall(): Active | null {
	try {
		const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Active>;
		const item = typeof value?.itemId === 'string' ? itemOf(value.itemId) : null;
		const index = Number.isInteger(value?.index) ? (value.index as number) : -1;
		return item && index >= 0 && index < item.steps.length ? { itemId: item.id, index } : null;
	} catch {
		return null;
	}
}

function setActive(next: Active | null): void {
	active = next;
	remember();
}

function takeDown(): void {
	cleanup?.();
	cleanup = null;
	if (!driver) return;
	closing = true;
	try {
		driver.destroy();
	} finally {
		closing = false;
	}
}

function driverConfig(dim: boolean): Config {
	const still = motionReduced();
	return {
		// The person works on the page while the guide points; nothing is blocked.
		allowPageInteraction: true,
		overlayClickBehavior: 'none',
		animate: !still,
		smoothScroll: !still,
		allowClose: true,
		popoverClass: 'console-guide',
		overlayOpacity: dim ? DIM : 0,
		stagePadding: 6,
		stageRadius: 8,
		onDestroyed: () => {
			// Escape or the close button: the guide ends. (Not when the guide itself took it down.)
			if (closing) return;
			finished = null;
			guide.stop();
		}
	};
}

async function driverInstance(dim = true): Promise<Driver> {
	if (!driver) {
		const { driver: create } = await import('driver.js');
		driver = create(driverConfig(dim));
	} else {
		driver.setConfig(driverConfig(dim));
	}
	return driver;
}

/** Whether an element takes room on the screen (false under `display: none`). */
const hasBox = (element: Element) => element.getClientRects().length > 0;

/** What the step points at, once it is on the page; null when it does not come in time. */
function findTarget(selector: string, mine: number): Promise<Element | null> {
	const found = document.querySelector(selector);
	if (found) return Promise.resolve(found);
	return new Promise((resolve) => {
		const done = (element: Element | null) => {
			observer.disconnect();
			clearTimeout(timer);
			resolve(element);
		};
		const observer = new MutationObserver(() => {
			if (mine !== generation) return done(null);
			const element = document.querySelector(selector);
			if (element) done(element);
		});
		const timer = setTimeout(() => done(null), TARGET_WAIT_MS);
		observer.observe(document.body, { childList: true, subtree: true });
	});
}

/**
 * Follows the page while a step is shown: shows the step again when what it points at was
 * replaced or removed (a tab was switched, a list was redrawn), or when it arrives late.
 */
function watchTarget(
	selector: string,
	element: Element | null,
	detour: Element | null = null
): () => void {
	let frame = 0;
	const observer = new MutationObserver(() => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			const gone =
				(element !== null && !element.isConnected) || (detour !== null && !detour.isConnected);
			const arrived = element === null && document.querySelector(selector) !== null;
			if (gone || arrived) void render();
		});
	});
	observer.observe(document.body, { childList: true, subtree: true });
	return () => {
		observer.disconnect();
		if (frame) cancelAnimationFrame(frame);
	};
}

function apply(move: Move): void {
	if (!active || !host) return;
	const item = itemOf(active.itemId);
	if (!item) return guide.stop();
	if (move.kind === 'finish') return void finish(item);
	const step = item.steps[move.index];
	setActive({ itemId: item.id, index: move.index });
	// A step on another page the guide can name: go there; the navigation shows the step.
	if (!matchesPath(step.path, host.pathname()) && isConcretePath(step.path)) {
		takeDown();
		void host.goto(step.path);
		return;
	}
	void render();
}

async function finish(item: ChecklistItem): Promise<void> {
	generation += 1;
	takeDown();
	setActive(null);
	finished = null;
	const mine = run;
	const saved = await onboardingProgress.complete(item.id);
	// Another guide was started, or the guide was stopped (the tenant changed), meanwhile. A
	// navigation is neither: a save that leads to another page still gets its "done".
	if (mine !== run || !host) return;
	// Not kept: say so, and do not claim the item is checked. It can be checked by hand.
	if (!saved) return host.onsavefailed?.();
	finished = item;
	void showDone();
}

/** The "done" popover of the item just finished. Shown again after a navigation. */
async function showDone(): Promise<void> {
	const mine = ++generation;
	const item = finished;
	if (!item || !host) return;
	const d = await driverInstance();
	if (mine !== generation || finished !== item || !host) return;
	const home = host.home;
	const dismiss = () => {
		finished = null;
		takeDown();
	};
	const leave = () => {
		dismiss();
		if (host && !matchesPath(home, host.pathname())) void host.goto(home);
	};
	d.highlight({
		popover: {
			title: escapeHtml(t('ob.done.title')),
			description: escapeHtml(t('ob.done.body', { name: t(item.title) })),
			showButtons: ['next', 'close'],
			nextBtnText: escapeHtml(t('ob.done.back')),
			closeBtnLabel: t('ob.close'),
			onNextClick: leave,
			onCloseClick: dismiss
		}
	});
}

function popoverOf(
	item: ChecklistItem,
	index: number,
	step: GuideStep,
	pathname: string,
	action = step.action
) {
	// The step as this environment words it (a detour has its own action and keeps it).
	const wording = wordingOf(step, guideFact);
	const body = wording.body;
	if (action === step.action) action = wording.action;
	const waits = waitsForPerson(step);
	const back = canGoBack(item.steps, index, pathname);
	return {
		title: escapeHtml(t(step.title)),
		description: escapeHtml(t(body)),
		instruction: action ? escapeHtml(t(action)) : undefined,
		showButtons: [
			...(back ? (['previous'] as const) : []),
			...(waits ? [] : (['next'] as const)),
			'close' as const
		],
		showProgress: item.steps.length > 1,
		progressText: escapeHtml(t('ob.stepOf', { current: index + 1, total: item.steps.length })),
		nextBtnText: escapeHtml(t('ob.next')),
		prevBtnText: escapeHtml(t('ob.back')),
		closeBtnLabel: t('ob.close'),
		onNextClick: () => apply(moveOn(item, index)),
		onPrevClick: () => apply({ kind: 'step', index: index - 1 }),
		onCloseClick: () => guide.stop()
	};
}

async function render(): Promise<void> {
	const mine = ++generation;
	cleanup?.();
	cleanup = null;
	// Nothing running: only the "done" popover of an item just finished stays (a save that leads
	// to another page must not take it away).
	if (!active && finished && host) return void showDone();
	if (!active || !host) return takeDown();
	const item = itemOf(active.itemId);
	if (!item) return guide.stop();
	const pathname = host.pathname();
	const index = locateStep(item.steps, active.index, pathname);
	// Not on one of the guide's pages: hidden until the person comes back to one.
	if (index === null) return takeDown();
	if (index !== active.index) setActive({ itemId: item.id, index });
	const step = item.steps[index];

	const target = step.target ? await findTarget(step.target, mine) : null;
	if (mine !== generation) return;
	// The target is behind something to open first: point at that, and say so.
	const detour = !target && step.fallback ? document.querySelector(step.fallback.target) : null;
	const element = target ?? detour;
	// Asked to open a tab that is open already (it was opened another way, from the "More" menu
	// of a narrow tab row): there is nothing to wait for. Not when the person pressed Back.
	if (
		step.advance === 'click' &&
		target?.getAttribute('aria-selected') === 'true' &&
		shown <= index
	) {
		shown = index;
		return apply(moveOn(item, index));
	}
	shown = index;
	const d = await driverInstance(step.dim !== false);
	if (mine !== generation) return;

	// Something that is on the page but takes no room (the navigation on a narrow screen) cannot
	// be pointed at: the text is shown in the middle instead.
	const pointed = element && hasBox(element) ? element : null;
	d.highlight({
		element: pointed ?? undefined,
		popover: popoverOf(item, index, step, pathname, detour ? step.fallback?.action : step.action)
	});

	const undo: Array<() => void> = [];
	if (element) {
		// The window was resized across the width where it appears or goes: show the step again.
		const onResize = () => {
			if (mine === generation && hasBox(element) !== (pointed !== null)) void render();
		};
		window.addEventListener('resize', onResize);
		undo.push(() => window.removeEventListener('resize', onResize));
	}
	if (step.target) undo.push(watchTarget(step.target, target, detour));
	if (step.advance === 'click' && target) {
		const element = target;
		const onClick = (event: Event) => {
			const at = event.target instanceof Element ? event.target : null;
			if (step.clickOn && !at?.closest(step.clickOn)) return;
			// After the page's own handling of the click (a tab switches, a part is added).
			setTimeout(() => {
				if (mine === generation) apply(moveOn(item, index));
			}, 0);
		};
		element.addEventListener('click', onClick, true);
		undo.push(() => element.removeEventListener('click', onClick, true));
	}
	cleanup = () => undo.forEach((fn) => fn());
}

export const guide = {
	/** The item being walked through, if any (also while the guide is hidden on another page). */
	get activeItemId(): string | null {
		return active?.itemId ?? null;
	},
	/** The item being walked through, whole. */
	get activeItem(): ChecklistItem | null {
		return active ? itemOf(active.itemId) : null;
	},
	/** The step the guide is at (0-based); -1 when none is running. */
	get activeIndex(): number {
		return active?.index ?? -1;
	},
	/** Storybook and tests: other items than the console's checklist. */
	useItems(next: readonly ChecklistItem[]): void {
		items = next;
	},
	/** The console's layout connects the guide to the router, and picks up a guide in progress. */
	connect(next: GuideHost): () => void {
		host = next;
		if (!active) active = recall();
		void render();
		// A page learned something about the environment that a step's wording depends on.
		const stopFacts = onGuideFactChange(() => void render());
		return () => {
			stopFacts();
			generation += 1;
			takeDown();
			host = null;
		};
	},
	/** Starts an item's guide, from its first step unless told otherwise, going to its page. */
	start(itemId: string, index = 0): void {
		const item = itemOf(itemId);
		if (!item || !item.steps[index] || !host) return;
		run += 1;
		finished = null;
		shown = -1;
		setActive({ itemId, index });
		const first = item.steps[index];
		if (!matchesPath(first.path, host.pathname()) && isConcretePath(first.path)) {
			takeDown();
			void host.goto(first.path);
			return;
		}
		void render();
	},
	/** Ends the guide. The item stays as it is. */
	stop(): void {
		run += 1;
		generation += 1;
		finished = null;
		setActive(null);
		takeDown();
	},
	/** The page changed (or its language): show the step that belongs here. */
	refresh(): void {
		void render();
	},
	/** A page reports something a step may be waiting for. */
	signal(signal: GuideSignal): void {
		if (!active) return;
		const item = itemOf(active.itemId);
		const move = item ? moveOnSignal(item, active.index, signal) : null;
		if (move) apply(move);
	}
};
