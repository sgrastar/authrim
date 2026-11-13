export type RateLimitProfileName = 'moderate' | 'lenient';

/**
 * Per-IP limits, each endpoint with its own bucket so wallet bootstrap reads (offer, metadata) do
 * not use up the exchange endpoints. Behind a school or office NAT many holders share one IP, so
 * the exchange endpoints only stop floods: guessing is bounded where each secret lives (an offer
 * locks after its transaction-code attempts; access tokens and VP responses are single-use), and
 * IDs naming an unconfigured shard are refused before any store is called.
 */
export const VC_RATE_LIMITS: ReadonlyArray<{
  path: string;
  endpoint: string;
  profile: RateLimitProfileName;
  endpointClass: string;
}> = [
  { path: '/vci/token', endpoint: '/vci/token', profile: 'lenient', endpointClass: 'vci_token' },
  {
    path: '/vci/credential',
    endpoint: '/vci/credential',
    profile: 'lenient',
    endpointClass: 'vci_credential',
  },
  // Unauthenticated and stored until expiry: one per issuance, so a lower limit still serves a class.
  { path: '/vci/nonce', endpoint: '/vci/nonce', profile: 'moderate', endpointClass: 'vci_nonce' },
  {
    path: '/vci/deferred',
    endpoint: '/vci/deferred',
    profile: 'moderate',
    endpointClass: 'vci_deferred',
  },
  {
    path: '/vci/status-lists/*',
    endpoint: '/vci/status-lists/',
    profile: 'moderate',
    endpointClass: 'vci_status_list',
  },
  {
    path: '/vci/offers/*',
    endpoint: '/vci/offers/',
    profile: 'lenient',
    endpointClass: 'vci_offer',
  },
  // Administrator presentations: single-use requests that a wrong match code or a bad response
  // fails for good, so the limits only stop floods.
  {
    path: '/vp/admin/response',
    endpoint: '/vp/admin/response',
    profile: 'moderate',
    endpointClass: 'vp_admin_response',
  },
  {
    path: '/vp/admin/request/*',
    endpoint: '/vp/admin/request/',
    profile: 'moderate',
    endpointClass: 'vp_admin_request',
  },
  {
    path: '/vp/response',
    endpoint: '/vp/response',
    profile: 'lenient',
    endpointClass: 'vp_response',
  },
  {
    path: '/vp/attribute-response',
    endpoint: '/vp/attribute-response',
    profile: 'lenient',
    endpointClass: 'vp_attribute_response',
  },
  {
    path: '/vp/initiate',
    endpoint: '/vp/initiate',
    profile: 'lenient',
    endpointClass: 'vp_initiate',
  },
  {
    path: '/vp/attributes',
    endpoint: '/vp/attributes',
    profile: 'moderate',
    endpointClass: 'vp_attributes',
  },
  {
    path: '/vp/authorize',
    endpoint: '/vp/authorize',
    profile: 'moderate',
    endpointClass: 'vp_authorize',
  },
  {
    path: '/vp/requests/*',
    endpoint: '/vp/requests/',
    profile: 'moderate',
    endpointClass: 'vp_requests',
  },
  {
    path: '/vp/request/*',
    endpoint: '/vp/request/',
    profile: 'lenient',
    endpointClass: 'vp_request_object',
  },
  {
    path: '/.well-known/*',
    endpoint: '/.well-known/',
    profile: 'lenient',
    endpointClass: 'vc_metadata',
  },
  // Anonymous, and for did:web the server fetches a document from a host the caller chooses
  // (10 s timeout, failures not cached): kept well below the other /did/ routes. A request is also
  // counted in the /did/ bucket below; the stricter bucket is the one that stops a flood.
  {
    path: '/did/resolve/*',
    endpoint: '/did/resolve/',
    profile: 'moderate',
    endpointClass: 'vc_did_resolve',
  },
  { path: '/did/*', endpoint: '/did/', profile: 'lenient', endpointClass: 'vc_did' },
];
