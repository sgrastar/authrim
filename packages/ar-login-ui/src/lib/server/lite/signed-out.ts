import { liteMessages } from '#lib/server/lite/messages.js';

/** The strings of the signed-out page (`/logged-out` and `/logout-complete`). */
export async function signedOutPage(locale: string | undefined) {
	const { LL } = await liteMessages(locale);
	return {
		title: LL.logout_completeTitle(),
		message: LL.logout_completeDescription(),
		back: LL.common_backToLogin()
	};
}
