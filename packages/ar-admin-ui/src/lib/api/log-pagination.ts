export interface LogCursorPagination {
	mode: 'cursor';
	limit: number;
	has_more: boolean;
	next_cursor: string | null;
}

export function logDetailQuery(eventAt?: number): string {
	return eventAt === undefined ? '' : `?event_at=${encodeURIComponent(eventAt)}`;
}
