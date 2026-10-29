/**
 * What the policy API hands back of a client's keys.
 *
 * A client contract keeps the client's JWKS (`encryption.jwks`) for encrypting tokens to it. That is
 * a public key set, but the profile PUT does not refuse a private member (`d`, `k`…) or a symmetric
 * (`oct`) key inside it, so the responses that echo the contract take them out. Only the places
 * that hold a key set are touched; the rest of the contract is returned as stored.
 */

const PRIVATE_JWK_MEMBERS: ReadonlySet<string> = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The public keys of a JWK Set. Anything that is not a set is dropped (undefined), as an unknown
 * shape could carry key material this cannot find.
 */
export function publicJwkSet(jwks: unknown): Record<string, unknown> | undefined {
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) return undefined;
  const keys = jwks.keys
    .filter((key): key is Record<string, unknown> => isRecord(key) && key.kty !== 'oct')
    .map((key) =>
      Object.fromEntries(Object.entries(key).filter(([member]) => !PRIVATE_JWK_MEMBERS.has(member)))
    );
  return { ...jwks, keys };
}

/** A copy of `holder` whose `jwks` is its public key set; `holder` itself when it has none. */
function withPublicJwks(holder: unknown): unknown {
  if (!isRecord(holder) || !('jwks' in holder)) return holder;
  const { jwks, ...rest } = holder;
  const publicSet = publicJwkSet(jwks);
  return publicSet === undefined ? rest : { ...rest, jwks: publicSet };
}

/** A client contract as the API returns it: `encryption.jwks` holds public keys only. */
export function redactClientContract<T>(contract: T): T {
  if (!isRecord(contract) || !isRecord(contract.encryption) || !('jwks' in contract.encryption)) {
    return contract;
  }
  return { ...contract, encryption: withPublicJwks(contract.encryption) } as T;
}

/**
 * The debug trace of a policy resolution. Its steps echo the contracts they read as `input`, the
 * client's encryption settings among them.
 */
export function redactResolutionDebug<T>(debug: T): T {
  if (!isRecord(debug) || !Array.isArray(debug.steps)) return debug;
  const steps = debug.steps.map((step: unknown) => {
    if (!isRecord(step) || !isRecord(step.input) || !('client' in step.input)) return step;
    const client = step.input.client;
    const redacted =
      isRecord(client) && isRecord(client.encryption)
        ? redactClientContract(client)
        : withPublicJwks(client);
    return { ...step, input: { ...step.input, client: redacted } };
  });
  return { ...debug, steps } as T;
}
