import { DEFAULTS } from '../common/constants';
import { formatDateTime } from '../common/xml-utils';

export interface SAMLAssertionTimingOptions {
  now?: Date;
  assertionValiditySeconds?: number;
  notBeforeSkewSeconds?: number;
}

export interface SAMLAssertionTiming {
  issueInstant: string;
  authnInstant: string;
  notBefore: string;
  notOnOrAfter: string;
}

export function buildSAMLAssertionTiming(
  options: SAMLAssertionTimingOptions = {}
): SAMLAssertionTiming {
  const now = options.now ?? new Date();
  const validitySeconds = options.assertionValiditySeconds ?? DEFAULTS.ASSERTION_VALIDITY_SECONDS;
  const notBeforeSkewSeconds = options.notBeforeSkewSeconds ?? DEFAULTS.CLOCK_SKEW_SECONDS;

  if (!Number.isFinite(validitySeconds) || validitySeconds <= 0) {
    throw new Error('SAML assertion validity must be a positive number of seconds');
  }
  if (!Number.isFinite(notBeforeSkewSeconds) || notBeforeSkewSeconds < 0) {
    throw new Error('SAML assertion NotBefore skew must be zero or a positive number of seconds');
  }

  const notBefore = new Date(now.getTime() - notBeforeSkewSeconds * 1000);
  const notOnOrAfter = new Date(now.getTime() + validitySeconds * 1000);

  return {
    issueInstant: formatDateTime(now),
    authnInstant: formatDateTime(now),
    notBefore: formatDateTime(notBefore),
    notOnOrAfter: formatDateTime(notOnOrAfter),
  };
}
