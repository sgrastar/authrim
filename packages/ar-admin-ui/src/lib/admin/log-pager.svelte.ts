import type { LogCursorPagination } from '$lib/api/log-pagination';

/** Cursor history belongs to one tenant/filter selection, with no inferred total or page number. */
export class LogPager {
	info = $state<LogCursorPagination | undefined>();
	private history = $state<string[]>(['']);
	private index = $state(0);
	private scope = '';
	get cursor() {
		return this.history[this.index] || undefined;
	}
	get hasPrevious() {
		return this.index > 0;
	}
	prepare(scope: string) {
		if (scope === this.scope) return;
		this.scope = scope;
		this.reset();
	}
	reset() {
		this.history = [''];
		this.index = 0;
		this.info = undefined;
	}
	next() {
		if (!this.info?.next_cursor) return;
		this.history = [...this.history.slice(0, this.index + 1), this.info.next_cursor];
		this.index++;
	}
	previous() {
		if (this.index > 0) this.index--;
	}
}
