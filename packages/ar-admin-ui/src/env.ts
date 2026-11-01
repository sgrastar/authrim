import { defineEnvVars } from '@sveltejs/kit/env';

// Public variables read at runtime. An unset variable is the empty string; callers treat an empty value like a missing one.
export const variables = defineEnvVars({
	PUBLIC_API_PROXY_BACKEND_URL: { public: true, schema: (input) => input ?? '' },
	PUBLIC_API_BASE_URL: { public: true, schema: (input) => input ?? '' },
	PUBLIC_AUTHRIM_ISSUER: { public: true, schema: (input) => input ?? '' }
});
