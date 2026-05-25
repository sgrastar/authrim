const MAX_SAML_RELAY_STATE_BYTES = 80;

export class SAMLRelayStateTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes = MAX_SAML_RELAY_STATE_BYTES
  ) {
    super(`SAML RelayState exceeds ${maxBytes} bytes`);
    this.name = 'SAMLRelayStateTooLargeError';
  }
}

export function assertSAMLRelayStateSize(relayState: string | null | undefined): void {
  if (!relayState) {
    return;
  }

  const byteLength = new TextEncoder().encode(relayState).byteLength;
  if (byteLength > MAX_SAML_RELAY_STATE_BYTES) {
    throw new SAMLRelayStateTooLargeError(byteLength);
  }
}
