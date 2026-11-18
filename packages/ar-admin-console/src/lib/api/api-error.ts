/**
 * One shape for every failed Admin API call, so pages handle failures the same way:
 *   403  → the admin may not do this (the page shows "no access", not an error); this includes
 *          `capability_disabled`, where the platform has turned the capability off for tenants
 *          (the message says so)
 *   404  → it does not exist (any more)
 *   409 `ADMIN_MUTATION_PAUSED_FOR_RELEASE` or 503 `CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE`
 *          → the environment is being updated and changes are paused (ReleasePausedError);
 *          nothing is wrong with what was sent, the same change works a little later
 *   409  → someone else changed it since it was loaded (ConflictError)
 *   400 with per-key reasons → some values were refused (RejectedError)
 *   else → something went wrong; the page offers to try again
 * The API answers `{ error, message | error_description, ...details }`.
 */
export class ApiError extends Error {
	readonly status: number;
	/** The API's machine-readable code (`forbidden`, `validation_failed`…); '' when none. */
	readonly code: string;
	readonly body: Record<string, unknown>;

	constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.body = body;
	}

	get forbidden(): boolean {
		return this.status === 403;
	}

	/** The platform has turned the capability off for tenants (403 `capability_disabled`). */
	get capabilityDisabled(): boolean {
		return this.status === 403 && this.code === 'capability_disabled';
	}

	get notFound(): boolean {
		return this.status === 404;
	}
}

/** The version sent with a change is not the current one: reload, then apply again. */
export class ConflictError extends ApiError {
	readonly currentVersion: string;

	constructor(message: string, body: Record<string, unknown>) {
		super(409, 'conflict', message, body);
		this.name = 'ConflictError';
		this.currentVersion = typeof body.currentVersion === 'string' ? body.currentVersion : '';
	}
}

/** The API codes of a change refused because a release is being rolled out. */
const RELEASE_PAUSE_CODES: Readonly<Record<string, number>> = {
	ADMIN_MUTATION_PAUSED_FOR_RELEASE: 409,
	CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE: 503
};

/** True for a code that says changes are paused for a release, whatever status it came with. */
export function isReleasePauseCode(code: unknown): boolean {
	return typeof code === 'string' && Object.hasOwn(RELEASE_PAUSE_CODES, code);
}

/** True when an answer with this status and code says changes are paused for a release. */
export function isReleasePause(status: number, code: unknown): boolean {
	return typeof code === 'string' && RELEASE_PAUSE_CODES[code] === status;
}

/**
 * The environment is being updated, so the Admin API takes no changes for now. Not an edit
 * conflict: nothing has to be reloaded, the same change works once the update is over.
 *
 * `status` is 503 whichever way the API answered (it answers 409 while the release is being
 * verified), so that no page reading `status === 409` takes this for a change made elsewhere.
 * The status the API sent is `httpStatus`.
 */
export class ReleasePausedError extends ApiError {
	readonly httpStatus: number;
	/** Seconds the API asks to wait before trying again; 0 when it did not say. */
	readonly retryAfterSeconds: number;

	constructor(
		httpStatus: number,
		code: string,
		message: string,
		body: Record<string, unknown> = {},
		retryAfterSeconds = 0
	) {
		super(503, code, message, body);
		this.name = 'ReleasePausedError';
		this.httpStatus = httpStatus;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

/** Every value in the change was refused; `rejected` says why, per key. */
export class RejectedError extends ApiError {
	readonly rejected: Readonly<Record<string, string>>;

	constructor(message: string, body: Record<string, unknown>) {
		super(400, 'validation_failed', message, body);
		this.name = 'RejectedError';
		this.rejected = isReasons(body.rejected) ? body.rejected : {};
	}
}

function isReasons(value: unknown): value is Record<string, string> {
	return (
		value !== null &&
		typeof value === 'object' &&
		Object.values(value).every((reason) => typeof reason === 'string')
	);
}

/** The error a failed response stands for. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
	const body = await response
		.json()
		.then((data: unknown) =>
			data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
		)
		.catch(() => ({}) as Record<string, unknown>);
	const code = typeof body.error === 'string' ? body.error : '';
	const message =
		(typeof body.message === 'string' && body.message) ||
		(typeof body.error_description === 'string' && body.error_description) ||
		`${response.status} ${response.statusText}`.trim();
	if (isReleasePause(response.status, code)) {
		const retryAfter = Number(response.headers.get('retry-after'));
		return new ReleasePausedError(
			response.status,
			code,
			message,
			body,
			Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
		);
	}
	if (response.status === 409) return new ConflictError(message, body);
	if (response.status === 400 && code === 'validation_failed')
		return new RejectedError(message, body);
	return new ApiError(response.status, code, message, body);
}
