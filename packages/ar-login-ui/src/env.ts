import { defineEnvVars } from '@sveltejs/kit/env';

// Public variables read at runtime. An unset variable is the empty string; callers treat an empty value like a missing one.
export const variables = defineEnvVars({
	PUBLIC_API_PROXY_BACKEND_URL: { public: true, schema: (input) => input ?? '' },
	PUBLIC_API_BASE_URL: { public: true, schema: (input) => input ?? '' },
	PUBLIC_AUTHRIM_ISSUER: { public: true, schema: (input) => input ?? '' },
	PUBLIC_HUMAN_VERIFICATION_PROVIDER: { public: true, schema: (input) => input ?? '' },
	// Origin Trial tokens of the sign-in pages: server-only and optional (unset is `undefined`).
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS: { schema: (input) => input },
	EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN: { schema: (input) => input }
});
