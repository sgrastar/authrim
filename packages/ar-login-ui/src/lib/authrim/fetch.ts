import { LOGIN_UI_SESSION_PROFILE, type AuthrimLoginUISessionProfile } from './session-profile';

export interface AuthrimFetchOptions extends RequestInit {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	sessionProfile?: AuthrimLoginUISessionProfile;
}

export function resolveAuthrimRequestUrl(input: string, baseUrl: string): string {
	if (/^https?:\/\//i.test(input)) {
		return input;
	}

	const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
	const normalizedPath = input.startsWith('/') ? input : `/${input}`;
	return `${normalizedBase}${normalizedPath}`;
}

export async function authrimFetch(
	input: string,
	options: AuthrimFetchOptions = {}
): Promise<Response> {
	const {
		baseUrl = '',
		fetchImpl = fetch,
		sessionProfile = LOGIN_UI_SESSION_PROFILE,
		...init
	} = options;
	const headers = new Headers(init.headers);
	const url = resolveAuthrimRequestUrl(input, baseUrl);

	// Built-in LoginUI uses Authrim's managed browser session profile:
	// HttpOnly cookie + server-side session, with no OAuth token material exposed to JS.
	const credentials =
		sessionProfile === 'token_session' ? init.credentials : ('include' as RequestCredentials);

	return fetchImpl(url, {
		...init,
		headers,
		credentials
	});
}
