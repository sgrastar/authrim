/**
 * The platform-neutral ports (`@authrim/ar-lib-core` `types/vc-runtime-ports`) must describe the
 * data the Cloudflare implementations already exchange. The checks below are made by the compiler
 * (design step P2): a drift of either side fails `tsc`, not a test run. Data shapes are compared
 * with `Exact` (both ways assignable, the same keys, the same optional keys); unions with `Same`.
 * What the ports expect is read from the port methods themselves (`Parameters` / `ReturnType`),
 * and what exists from the real classes.
 */
import { describe, expect, it } from 'vitest';
import { assertVcRoutePorts } from '@authrim/ar-lib-core';
import type {
  HaipLoginStateStore,
  ProofNonceStore,
  VcKeyCustody,
  VcRefusal,
  VcSigned,
  VcSigningCertificateStateView,
  VerifierGateway,
  VCIssuerServiceBinding,
} from '@authrim/ar-lib-core';
import type {
  KeyManager,
  SetVcIssuerKeyCertificateChainInput,
  SignSDJWTIssuerResult,
  VcSigningCertificateState,
} from '@authrim/ar-lib-core/durable-objects/KeyManager';
import type { Env } from '../types';
import type { VCIssuerEntrypoint } from '../entrypoints/VCIssuerEntrypoint';
import type {
  CreateProofNonceInput,
  CredentialOfferStore,
  ReserveProofNonceInput,
  ReserveProofNonceResult,
} from '../issuer/durable-objects/CredentialOfferStore';
import type {
  HaipLoginRequestInput,
  HaipLoginRequestRecord,
  HaipLoginRequestTable,
  HaipLoginResult,
  HaipLoginStatus,
  ReserveHaipLoginResult,
} from '../verifier/haip-login/haip-login-request-store';

/** `true` only when A and B are assignable to each other (`false` otherwise, never `never`). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
/** Same shape: mutual assignability, the same keys and the same optional keys (data objects only). */
type Exact<A, B> = [Same<A, B>] extends [true]
  ? [Same<keyof A, keyof B>] extends [true]
    ? [Same<OptionalKeys<A>, OptionalKeys<B>>] extends [true]
      ? true
      : false
    : false
  : false;

type StateStore = HaipLoginStateStore;
type NonceStore = ProofNonceStore;

// Proof nonce: the port methods against the Durable Object's inputs and results.
export const nonceCreate: Exact<Parameters<NonceStore['create']>[0], CreateProofNonceInput> = true;
export const nonceReserve: Exact<Parameters<NonceStore['reserve']>[0], ReserveProofNonceInput> =
  true;
export const nonceResult: Same<
  Awaited<ReturnType<NonceStore['reserve']>>,
  ReserveProofNonceResult
> = true;
export const nonceComplete: Exact<
  Parameters<NonceStore['complete']>[0],
  Parameters<CredentialOfferStore['completeProofNonceRpc']>[0]
> = true;
export const nonceRelease: Exact<
  Parameters<NonceStore['release']>[0],
  Parameters<CredentialOfferStore['releaseProofNonceRpc']>[0]
> = true;

// HAIP login state: the port methods against the table's inputs and results.
export const loginCreate: Exact<Parameters<StateStore['create']>[0], HaipLoginRequestInput> = true;
export const loginReserve: Same<
  Awaited<ReturnType<StateStore['reserveResponse']>>,
  ReserveHaipLoginResult
> = true;
export const loginCompleteResult: Exact<
  Parameters<StateStore['complete']>[0]['result'],
  Parameters<HaipLoginRequestTable['complete']>[3]
> = true;
// The whole results, with the `null` of a refusal: nothing is stripped before the comparison.
export const loginConsume: Same<
  Awaited<ReturnType<StateStore['consume']>>,
  ReturnType<HaipLoginRequestTable['consume']>
> = true;
export const loginStatus: Same<
  Awaited<ReturnType<StateStore['getStatus']>>,
  ReturnType<HaipLoginRequestTable['status']>
> = true;
export const loginResultShape: Exact<
  NonNullable<Awaited<ReturnType<StateStore['consume']>>>,
  HaipLoginResult
> = true;
export const loginStatusValue: Same<
  NonNullable<Awaited<ReturnType<StateStore['getStatus']>>>['status'],
  HaipLoginStatus
> = true;
export const loginRecord: Exact<
  Extract<Awaited<ReturnType<StateStore['reserveResponse']>>, { reserved: true }>['request'],
  HaipLoginRequestRecord
> = true;

// Key custody: every method against what the Durable Object really returns, plus a refusal.
type Custody = VcKeyCustody;
type Rpc<K extends keyof KeyManager> = KeyManager[K] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;
export const custodySignSdJwt: Same<
  Awaited<ReturnType<Custody['signSdJwtIssuer']>>,
  Rpc<'signSDJWTIssuerRpc'> | VcRefusal
> = true;
export const custodySignStatusList: Same<
  Awaited<ReturnType<Custody['signStatusListCredential']>>,
  Rpc<'signStatusListCredentialRpc'> | VcRefusal
> = true;
export const custodySignLogin: Same<
  Awaited<ReturnType<Custody['signHaipLoginRequest']>>,
  Rpc<'signHaipLoginRequestRpc'> | VcRefusal
> = true;
export const custodyVerifier: Same<
  Awaited<ReturnType<Custody['getHaipLoginVerifier']>>,
  Rpc<'getHaipLoginVerifierRpc'> | VcRefusal
> = true;
export const custodyCertState: Same<
  Awaited<ReturnType<Custody['getCertificateState']>>,
  Rpc<'getVcSigningCertificateStateRpc'> | VcRefusal
> = true;
export const custodyRegister: Same<
  Awaited<ReturnType<Custody['setCertificateChain']>>,
  Rpc<'setVcIssuerKeyCertificateChainRpc'> | VcRefusal
> = true;
export const custodyJwks: Same<
  Awaited<ReturnType<Custody['getJwks']>>,
  Rpc<'getVcIssuerJwksRpc'>
> = true;
export const custodyChainInput: Exact<
  Parameters<Custody['setCertificateChain']>[1],
  SetVcIssuerKeyCertificateChainInput
> = true;
export const custodySignedShape: Exact<VcSigned, SignSDJWTIssuerResult> = true;
export const custodyStateShape: Exact<VcSigningCertificateStateView, VcSigningCertificateState> =
  true;

// The real entrypoint (the other side of the Cloudflare service binding) and the binding type
// itself satisfy the gateway; the gateway may in addition answer a known refusal as a value.
export const gateway: VerifierGateway = {} as Pick<
  VCIssuerEntrypoint,
  'createHaipLoginRequest' | 'getHaipLoginStatus' | 'consumeHaipLoginResult'
>;
export const bindingGateway: VerifierGateway = {} as Pick<
  VCIssuerServiceBinding,
  'createHaipLoginRequest' | 'getHaipLoginStatus' | 'consumeHaipLoginResult'
>;

// The worker's own `Env` can be handed to the accessors as it is.
export function startUp(env: Env): void {
  assertVcRoutePorts(env, 'ar-vc.nonce');
}

describe('port types conform to the Cloudflare implementations', () => {
  it('is checked by the compiler', () => {
    expect([
      nonceCreate,
      loginCreate,
      custodySignedShape,
      gateway !== undefined,
      typeof startUp,
    ]).toEqual([true, true, true, true, 'function']);
  });
});
