/** What the header's notification area shows. Pure model: the component only renders it. */

/** Most urgent first. The header shows one circle and one count for each. */
export const SEVERITIES = ['critical', 'high', 'caution', 'info'] as const;
export type NotificationSeverity = (typeof SEVERITIES)[number];

/**
 * critical  a failure is happening now
 * high      a failure is likely if nothing is done
 * caution   not a failure, but a problem
 * info      everything else
 */
export interface ShellNotification {
	id: string;
	severity: NotificationSeverity;
	/** The whole message, shown in the expanded list. */
	text: string;
	/** A display time such as "12:04" or "3 min ago"; formatting belongs to the caller. */
	time?: string;
}

/** The notification's page under the operations category; it is where the others are deleted. */
export function notificationHref(id: string): string {
	return `/admin/integrations/notifications?id=${encodeURIComponent(id)}`;
}

/**
 * Only information can be dismissed on the spot. The others are deleted from their own page, after
 * they have been looked at.
 */
export function isDismissible(notification: ShellNotification): boolean {
	return notification.severity === 'info';
}

export type NotificationCounts = Record<NotificationSeverity, number>;

export function countNotifications(items: readonly ShellNotification[]): NotificationCounts {
	const counts: NotificationCounts = { critical: 0, high: 0, caution: 0, info: 0 };
	for (const item of items) counts[item.severity] += 1;
	return counts;
}

/**
 * Most urgent first. The caller passes the items newest first, and that order is kept inside a
 * severity, so an urgent item is never pushed below a minor one by the clock alone.
 */
export function orderNotifications(items: readonly ShellNotification[]): ShellNotification[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort(
			(a, b) =>
				SEVERITIES.indexOf(a.item.severity) - SEVERITIES.indexOf(b.item.severity) ||
				a.index - b.index
		)
		.map(({ item }) => item);
}
