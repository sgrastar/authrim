import { describe, expect, it } from 'vitest';
import { adminVPRequestDid } from '../KeyManager';

const NOW = 1_800_000_000;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    aud: 'https://self-issued.me/v2',
    client_id: 'decentralized_identifier:did:web:idp.example.com',
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: 'https://idp.example.com/vp/admin/response',
    nonce: 'n'.repeat(43),
    state: 'g1:apac:0:vp_x',
    iat: NOW,
    exp: NOW + 300,
    dcql_query: { credentials: [] },
    transaction_data: ['eyJ0eXBlIjoiYSJ9'],
    ...overrides,
  };
}

describe('adminVPRequestDid', () => {
  it('names the did:web of the one request shape KeyManager signs', () => {
    expect(adminVPRequestDid(payload(), NOW)).toBe('did:web:idp.example.com');
  });

  it.each([
    ['another prefix', { client_id: 'x509_san_dns:idp.example.com' }],
    ['a did:web with a path', { client_id: 'decentralized_identifier:did:web:idp.example.com:t' }],
    ['another DID method', { client_id: 'decentralized_identifier:did:key:z6Mk' }],
    ['a response on another host', { response_uri: 'https://evil.example/vp/admin/response' }],
    ['a plain http response', { response_uri: 'http://idp.example.com/vp/admin/response' }],
    ['a response with a port', { response_uri: 'https://idp.example.com:8443/vp' }],
    ['an id_token request', { response_type: 'id_token' }],
    ['another response mode', { response_mode: 'fragment' }],
    ['a short nonce', { nonce: 'short' }],
    ['no state', { state: '' }],
    ['a stale iat', { iat: NOW - 3_600, exp: NOW - 3_300 }],
    ['a long lifetime', { exp: NOW + 3_600 }],
    ['no dcql query', { dcql_query: null }],
    ['no transaction data', { transaction_data: [] }],
    ['two transaction data entries', { transaction_data: ['a', 'b'] }],
    ['an oversized payload', { dcql_query: { pad: 'x'.repeat(20_000) } }],
  ])('refuses %s', (_label, overrides) => {
    expect(adminVPRequestDid(payload(overrides), NOW)).toBeNull();
  });
});
