/**
 * The request headers ar-auth's CORS lets a cross-origin page send.
 *
 * `X-Authrim-Relay` must never be among them: with it, a consent answer's form post comes back as
 * data (its destination and fields) instead of an auto-submitting page (authorize.ts
 * `answerFormPostAsData`). Only a same-origin caller and the lite Login UI's server may ask for
 * that; a page of another origin cannot set the header, so it cannot read a form post's fields.
 */
export const AUTH_CORS_ALLOW_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'X-Session-Id',
  'X-Authrim-Interaction-Id',
];
