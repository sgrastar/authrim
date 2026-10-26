import { createHash } from 'node:crypto';

const CLIENT_ID = 'login-ui';

/**
 * Deliberately small browser client for the readiness-validated SAML/passkey Flow profile.
 * Authrim's existing Flow and DirectAuth handlers remain the policy and proof authorities.
 */
const LOGIN_SCRIPT = String.raw`
(() => {
  'use strict';
  const button = document.getElementById('sign-in');
  const status = document.getElementById('status');
  const search = new URLSearchParams(location.search);
  const requestId = search.get('saml_request_id');
  const spEntityId = search.get('saml_sp_entity_id');
  const challengeId = search.get('challenge_id');
  let flow;
  let busy = false;

  function fail(message) {
    status.textContent = message;
    button.disabled = true;
  }

  function base64url(bytes) {
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('invalid_webauthn_options');
    }
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  async function post(path, body, interactionId) {
    const headers = { 'Content-Type': 'application/json' };
    if (interactionId) headers['X-Authrim-Interaction-Id'] = interactionId;
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('request_failed');
    return response.json();
  }

  function validateFlow(value) {
    const contract = value && value.contract;
    const steps = contract && contract.ui && contract.ui.steps;
    const interaction = value && value.interaction;
    if (contract.flow_kind !== 'login' || !Array.isArray(steps) || ![2, 3].includes(steps.length) ||
      !interaction || interaction.state !== 'active' || !value.contract_hash || !value.signature) {
      throw new Error('unsupported_flow');
    }
    const entry = steps.length === 3 ? steps[0] : null;
    const auth = steps.length === 3 ? steps[1] : steps[0];
    const completion = steps.length === 3 ? steps[2] : steps[1];
    const profile = auth && auth.content && auth.content.authentication_profile;
    if (entry && (entry.component !== 'interaction_context' || entry.render !== false)) {
      throw new Error('unsupported_flow');
    }
    if (auth.component !== 'authentication_method_selector' || auth.render !== true ||
      !auth.config || !Array.isArray(auth.config.output_handles) ||
      auth.config.output_handles.length !== 1 || auth.config.output_handles[0] !== 'passkey' ||
      Object.keys(auth.config).some((key) => key !== 'output_handles') ||
      (auth.content && (Object.keys(auth.content).length !== 1 || !profile ||
        Object.keys(profile).some((key) => key !== 'id' && key !== 'output_handles') ||
        typeof profile.id !== 'string' || !Array.isArray(profile.output_handles) ||
        profile.output_handles.length !== 1 || profile.output_handles[0] !== 'passkey')) ||
      completion.component !== 'completion' || interaction.current_step_id !== auth.id) {
      throw new Error('unsupported_flow');
    }
    return auth;
  }

  function makePublicKey(options) {
    if (!options || typeof options !== 'object' || !options.challenge || !options.rpId) {
      throw new Error('invalid_webauthn_options');
    }
    return {
      challenge: fromBase64url(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: 'required',
      allowCredentials: Array.isArray(options.allowCredentials)
        ? options.allowCredentials.map((entry) => ({
          id: fromBase64url(entry.id),
          type: entry.type,
          transports: entry.transports,
        }))
        : [],
      extensions: options.extensions,
    };
  }

  function serializeCredential(credential) {
    if (!credential || credential.type !== 'public-key' || !credential.response ||
      !credential.response.authenticatorData || !credential.response.signature) {
      throw new Error('invalid_webauthn_response');
    }
    return {
      id: credential.id,
      rawId: base64url(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      response: {
        authenticatorData: base64url(credential.response.authenticatorData),
        clientDataJSON: base64url(credential.response.clientDataJSON),
        signature: base64url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? base64url(credential.response.userHandle) : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  async function submitFlowStep(step, handle) {
    const result = await post('/api/v1/login/interactions/' + encodeURIComponent(flow.interaction.id) + '/submit', {
      step_id: step.id,
      node_id: step.source_node_id,
      selected_handle: handle,
      contract_hash: flow.contract_hash,
      signature: flow.signature,
    });
    if (!result || !result.interaction) throw new Error('invalid_flow_response');
    flow.interaction = result.interaction;
    return result;
  }

  async function start() {
    if (!requestId || !spEntityId || search.get('return_to') !== 'saml_sso' ||
      (location.pathname === '/reauth' && !challengeId)) {
      return fail('This sign-in request is invalid. Return to your application and try again.');
    }
    try {
      flow = await post('/api/v1/login/interactions/start', {
        flow_kind: 'login',
        target_type: 'saml_sp',
        target_id: spEntityId,
        saml_sp_id: spEntityId,
        saml_request_id: requestId,
        saml_sp_entity_id: spEntityId,
        return_to: 'saml_sso',
        authorization_challenge_id: challengeId || undefined,
      });
      validateFlow(flow);
      button.disabled = false;
      status.textContent = 'Use a passkey to sign in.';
    } catch {
      fail('Sign-in is temporarily unavailable. Return to your application and try again.');
    }
  }

  button.addEventListener('click', async () => {
    if (busy || !flow) return;
    busy = true;
    button.disabled = true;
    status.textContent = 'Waiting for your passkey…';
    try {
      const authStep = validateFlow(flow);
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const options = await post('/api/v1/auth/direct/passkey/login/start', {
        client_id: document.documentElement.dataset.clientId,
        code_challenge: base64url(digest),
        code_challenge_method: 'S256',
        channel: 'browser',
        authorization_challenge_id: challengeId || undefined,
      }, flow.interaction.id);
      if (!options.challenge_id) throw new Error('invalid_webauthn_options');
      const credential = await navigator.credentials.get({ publicKey: makePublicKey(options.options) });
      const finished = await post('/api/v1/auth/direct/passkey/login/finish', {
        challenge_id: options.challenge_id,
        credential: serializeCredential(credential),
        code_verifier: verifier,
        channel: 'browser',
      });
      if (!finished.direct_auth_artifact) throw new Error('invalid_auth_artifact');
      const session = await post('/api/v1/auth/direct/session', {
        direct_auth_artifact: finished.direct_auth_artifact,
        client_id: document.documentElement.dataset.clientId,
        code_verifier: verifier,
        channel: 'browser',
        authorization_challenge_id: challengeId || undefined,
        defer_authorization_continuation: true,
      });
      if (session.ok !== true) throw new Error('session_failed');
      let result = await submitFlowStep(authStep, 'passkey');
      if (!result.completed) {
        if (!result.step || result.step.component !== 'completion') throw new Error('unsupported_flow');
        result = await submitFlowStep(result.step, 'completed');
      }
      const continuation = result.output && result.output.protocol_continuation;
      if (!result.completed || !continuation || continuation.protocol !== 'saml' ||
        continuation.saml_request_id !== requestId ||
        continuation.saml_sp_entity_id !== spEntityId) {
        throw new Error('invalid_flow_continuation');
      }
      const resume = new URL('/saml/idp/sso', location.origin);
      resume.searchParams.set('saml_request_id', requestId);
      resume.searchParams.set('saml_sp_entity_id', spEntityId);
      resume.searchParams.set('return_to', 'saml_sso');
      location.assign(resume.toString());
    } catch {
      status.textContent = 'Sign-in failed. Return to your application and try again.';
      button.disabled = false;
    } finally {
      busy = false;
    }
  });

  void start();
})();
`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Same-origin LoginUI replacement for the explicitly supported AWS SAML DR profile. */
export function renderAwsPasskeyLoginPage(request: Request): Response {
  const url = new URL(request.url);
  const requestId = url.searchParams.get('saml_request_id');
  const spEntityId = url.searchParams.get('saml_sp_entity_id');
  const challengeId = url.searchParams.get('challenge_id');
  if (
    !requestId ||
    requestId.length > 512 ||
    !spEntityId ||
    spEntityId.length > 512 ||
    url.searchParams.get('return_to') !== 'saml_sso' ||
    (url.pathname === '/reauth' && !challengeId) ||
    (challengeId !== null && (challengeId.length === 0 || challengeId.length > 512))
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const scriptHash = createHash('sha256').update(LOGIN_SCRIPT).digest('base64');
  const html = `<!doctype html>
<html lang="en" data-client-id="${escapeHtml(CLIENT_ID)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Authrim</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f5f6f8;color:#162133;margin:0;min-height:100vh;display:grid;place-items:center}main{background:#fff;border:1px solid #dce2e9;border-radius:16px;padding:2.5rem;max-width:28rem;width:calc(100% - 3rem);box-shadow:0 12px 36px #14213d12}h1{font-size:1.5rem;margin:0 0 .75rem}p{line-height:1.5;color:#526174}button{background:#174783;color:#fff;border:0;border-radius:8px;padding:.9rem 1.2rem;font:inherit;font-weight:600;width:100%;cursor:pointer}button:disabled{opacity:.55;cursor:wait}button:focus-visible{outline:3px solid #ffb84c;outline-offset:3px}</style>
</head>
<body><main><h1>Sign in</h1><p id="status" role="status" aria-live="polite">Preparing sign-in…</p><button id="sign-in" type="button" disabled>Sign in with passkey</button></main>
<script>${LOGIN_SCRIPT}</script></body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'`,
    },
  });
}
