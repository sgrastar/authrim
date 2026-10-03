/** A widget's own heading: h2 as a card of its own, h3 inside a parent panel. */
export type AccountWidgetHeadingLevel = 2 | 3;

/** Props every refreshable account widget shares with its panel frame. */
export type AccountWidgetCommonProps = {
	/** Defaults to the widget's own name. */
	title?: string;
	headingLevel?: AccountWidgetHeadingLevel;
	/** First load: draws a skeleton instead of the (possibly empty) list. */
	loading?: boolean;
	/** A manual refresh is running: the refresh button spins, the list stays. */
	refreshing?: boolean;
	error?: string;
	/** With an error, offers re-authentication. */
	reauthNeeded?: boolean;
	/** Omit to hide the refresh button (a parent panel refreshes instead). */
	onRefresh?: () => void;
	onReauthenticate?: () => void;
};

/** An authenticator app enrollment the account API has started. */
export type AccountTotpEnrollment = {
	credentialId: string;
	secret: string;
	otpauthUri: string;
	backupCodes: string[];
};

/** A 6- or 8-digit authenticator code. */
export const TOTP_CODE_PATTERN = /^\d{6}$|^\d{8}$/;
