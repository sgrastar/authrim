import type { ApprovalCompletionRequirementsView } from './approval-completion-guidance';

export interface ApprovalArtifactPortalRequestView {
  public_request_id: string;
  investigation_id: string;
  request_surface: string;
  requested_action: string;
  redaction_level: string;
  reason_code: string;
  ticket_reference: {
    system: string;
    id: string;
  } | null;
}

export interface ApprovalArtifactPortalApprovalView {
  step_key: string;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderApprovalArtifactPortalPage(input: {
  artifactId: string;
  request: ApprovalArtifactPortalRequestView;
  approval: ApprovalArtifactPortalApprovalView;
  completionRequirements: ApprovalCompletionRequirementsView;
}): string {
  const { artifactId, request, approval, completionRequirements } = input;
  const pageData = {
    artifactId,
    method: completionRequirements.method,
    fallbackMethods: completionRequirements.acceptable_methods.filter(
      (method) => method !== completionRequirements.method
    ),
    completionPath: `/api/approval-artifacts/${encodeURIComponent(artifactId)}/complete`,
    switchMethodPath: completionRequirements.switch_method_path,
    passkeyOptionsPath:
      completionRequirements.method === 'passkey'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/passkey/options`
        : null,
    passkeyVerifyPath:
      completionRequirements.method === 'passkey'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/passkey/verify`
        : null,
    reauthAssertPath:
      completionRequirements.method === 'reauth'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/reauth/assert`
        : null,
    otpVerifyPath:
      completionRequirements.method === 'email_otp' || completionRequirements.method === 'sms_otp'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/otp/verify`
        : null,
    cibaStartPath:
      completionRequirements.method === 'ciba'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/ciba/start`
        : null,
    cibaStatusPath:
      completionRequirements.method === 'ciba'
        ? `/api/approval-artifacts/${encodeURIComponent(artifactId)}/ciba/status`
        : null,
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authrim Approval Request</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f4f6fb; color: #132033; }
      .shell { max-width: 760px; margin: 48px auto; padding: 24px; }
      .card { background: white; border-radius: 18px; padding: 24px; box-shadow: 0 24px 60px rgba(16, 24, 40, 0.08); }
      h1 { margin: 0 0 8px; font-size: 1.75rem; }
      p { line-height: 1.55; }
      dl { display: grid; grid-template-columns: 160px 1fr; gap: 10px 16px; margin: 24px 0; }
      dt { font-weight: 700; color: #3a4a63; }
      dd { margin: 0; word-break: break-word; }
      code { background: #eef2ff; padding: 2px 6px; border-radius: 6px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
      button { border: 0; border-radius: 999px; padding: 12px 20px; font-weight: 700; cursor: pointer; }
      .approve { background: #0f8b5f; color: white; }
      .deny { background: #d92d20; color: white; }
      .secondary { background: #dfe7f5; color: #132033; }
      .hidden { display: none; }
      .otp-box, .stepup-box { margin-top: 20px; padding: 16px; border-radius: 14px; background: #f8fafc; }
      .otp-box input { width: 100%; max-width: 240px; font-size: 1.1rem; padding: 10px 12px; border-radius: 10px; border: 1px solid #c7d2e5; letter-spacing: 0.2rem; }
      .status { margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: #eef6ff; color: #143666; white-space: pre-wrap; }
      .status.error { background: #fff1f0; color: #8a1c14; }
      .hint { color: #4b6483; font-size: 0.95rem; }
      .guidance { margin-bottom: 18px; padding: 16px; border-radius: 14px; background: #eef4ff; color: #143666; }
      .guidance h2 { margin: 0 0 8px; font-size: 1rem; }
      .guidance ul { margin: 10px 0 0 18px; padding: 0; }
      .guidance li { margin: 6px 0; }
      .guidance code { background: rgba(255, 255, 255, 0.68); }
      .fallbacks { margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(20, 54, 102, 0.12); }
      .fallbacks h3 { margin: 0 0 8px; font-size: 0.95rem; }
      .fallback-buttons { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
      .fallback-buttons button { background: white; color: #143666; border: 1px solid rgba(20, 54, 102, 0.16); }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <h1>Approval request</h1>
        <p>Review the request details below and complete the approval step.</p>
        <div class="guidance">
          <h2>${escapeHtml(completionRequirements.guidance_title)}</h2>
          <p>${escapeHtml(completionRequirements.guidance_body)}</p>
          <ul>
            <li>Primary method: <code>${escapeHtml(completionRequirements.method)}</code></li>
            <li>Portal path: <code>${escapeHtml(completionRequirements.portal_path)}</code></li>
            ${
              completionRequirements.transport_channel
                ? `<li>Delivery target: <code>${escapeHtml(completionRequirements.transport_channel)}</code></li>`
                : ''
            }
            <li>Available methods: <code>${escapeHtml(completionRequirements.acceptable_methods.join(', '))}</code></li>
            ${
              completionRequirements.fallback_note
                ? `<li>${escapeHtml(completionRequirements.fallback_note)}</li>`
                : ''
            }
          </ul>
          ${
            completionRequirements.switch_method_path &&
            completionRequirements.acceptable_methods.filter(
              (method) => method !== completionRequirements.method
            ).length > 0
              ? `<div class="fallbacks">
                   <h3>Need another method?</h3>
                   <p class="hint">Re-issue this approval step with one of the fallback methods below.</p>
                   <div class="fallback-buttons">
                     ${completionRequirements.acceptable_methods
                       .filter((method) => method !== completionRequirements.method)
                       .map(
                         (method) =>
                           `<button class="secondary" type="button" data-fallback-method="${escapeHtml(method)}">Switch to ${escapeHtml(method)}</button>`
                       )
                       .join('')}
                   </div>
                 </div>`
              : ''
          }
        </div>
        <dl>
          <dt>Investigation</dt><dd>${escapeHtml(request.investigation_id)}</dd>
          <dt>Surface</dt><dd>${escapeHtml(request.request_surface)}</dd>
          <dt>Action</dt><dd>${escapeHtml(request.requested_action)}</dd>
          <dt>Reason</dt><dd>${escapeHtml(request.reason_code)}</dd>
          <dt>Step</dt><dd>${escapeHtml(approval.step_key)}</dd>
          <dt>Method</dt><dd>${escapeHtml(completionRequirements.method)}</dd>
          <dt>Redaction</dt><dd>${escapeHtml(request.redaction_level)}</dd>
          <dt>Ticket</dt><dd>${request.ticket_reference ? escapeHtml(`${request.ticket_reference.system}:${request.ticket_reference.id}`) : 'None'}</dd>
        </dl>
        <p class="hint">Request ID: <code>${escapeHtml(request.public_request_id)}</code></p>
        ${
          completionRequirements.method === 'portal_confirm'
            ? `<div class="actions">
                <button class="approve" id="approve-button">Approve</button>
                <button class="deny" id="deny-button">Deny</button>
               </div>`
            : completionRequirements.method === 'email_otp' ||
                completionRequirements.method === 'sms_otp'
              ? `<div class="otp-box">
                  <label for="otp-code"><strong>Verification code</strong></label>
                  <p class="hint">Enter the code delivered through ${escapeHtml(completionRequirements.transport_channel ?? completionRequirements.method)}.</p>
                  <input id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />
                  <div class="actions">
                    <button class="approve" id="otp-approve-button">Verify and approve</button>
                    <button class="deny" id="otp-deny-button">Deny</button>
                  </div>
                 </div>`
              : completionRequirements.method === 'passkey'
                ? `<div class="stepup-box">
                    <p class="hint">Use a registered admin passkey to approve this request from the current browser.</p>
                    <div class="actions">
                      <button class="approve" id="passkey-approve-button">Use passkey to approve</button>
                      <button class="deny" id="passkey-deny-button">Deny</button>
                    </div>
                   </div>`
                : completionRequirements.method === 'reauth'
                  ? `<div class="stepup-box">
                      <p class="hint">Confirm this request with the currently authenticated admin session.</p>
                      <div class="actions">
                        <button class="approve" id="reauth-approve-button">Confirm with current session</button>
                        <button class="deny" id="reauth-deny-button">Deny</button>
                      </div>
                     </div>`
                  : `<div class="status">
                       ${
                         completionRequirements.method === 'ciba'
                           ? `Start the backchannel approval request, then complete it on the authentication device.`
                           : `This approval method requires a dedicated step-up flow.`
                       }
                     </div>
                     ${
                       completionRequirements.method === 'ciba'
                         ? `<div class="actions">
                              <button class="secondary" id="ciba-start-button">Start CIBA approval</button>
                              <button class="deny" id="ciba-deny-button">Deny</button>
                            </div>`
                         : ''
                     }`
        }
        <div class="status hidden" id="status-box"></div>
      </div>
    </div>
    <script>
      const pageData = ${jsonForInlineScript(pageData)};
      const statusBox = document.getElementById('status-box');
      const setStatus = (message, isError = false) => {
        statusBox.textContent = message;
        statusBox.classList.remove('hidden');
        statusBox.classList.toggle('error', isError);
      };

      function base64urlToUint8Array(value) {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function arrayBufferToBase64url(value) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
      }

      function decodePasskeyOptions(options) {
        return {
          ...options,
          challenge: base64urlToUint8Array(options.challenge),
          allowCredentials: (options.allowCredentials || []).map((item) => ({
            ...item,
            id: base64urlToUint8Array(item.id),
          })),
        };
      }

      function credentialToJSON(credential) {
        return {
          id: credential.id,
          rawId: arrayBufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: arrayBufferToBase64url(credential.response.clientDataJSON),
            authenticatorData: arrayBufferToBase64url(credential.response.authenticatorData),
            signature: arrayBufferToBase64url(credential.response.signature),
            userHandle: credential.response.userHandle
              ? arrayBufferToBase64url(credential.response.userHandle)
              : null,
          },
        };
      }

      async function complete(decision, completionAssertion) {
        const res = await fetch(pageData.completionPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            ...(completionAssertion ? { completion_assertion: completionAssertion } : {})
          })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error_description || payload.error || 'Approval completion failed');
        }
        if (payload.receipt_portal_path) {
          setStatus('Decision recorded. Redirecting to your receipt...');
          window.location.assign(payload.receipt_portal_path);
          return;
        }
        setStatus(\`Decision recorded: \${payload.decision}\\nRequest status: \${payload.request_status}\`);
      }

      async function denyWithoutAssertion() {
        setStatus('Submitting denial...');
        try {
          await complete('denied');
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Approval completion failed', true);
        }
      }

      async function switchMethod(method) {
        if (!pageData.switchMethodPath) {
          setStatus('No fallback method switch is available for this approval step.', true);
          return;
        }

        setStatus('Issuing a new approval artifact...');
        try {
          const res = await fetch(pageData.switchMethodPath, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload.error_description || payload.error || 'Failed to switch completion method');
          }
          const nextPortalPath = payload.completion_requirements?.portal_path;
          setStatus('Fallback method issued. Redirecting to the new approval page...');
          if (nextPortalPath) {
            window.location.assign(nextPortalPath);
          }
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Failed to switch completion method', true);
        }
      }

      document.querySelectorAll('[data-fallback-method]').forEach((button) => {
        button.addEventListener('click', () => {
          const method = button.getAttribute('data-fallback-method');
          if (!method) {
            return;
          }
          void switchMethod(method);
        });
      });

      const approveButton = document.getElementById('approve-button');
      if (approveButton) {
        approveButton.addEventListener('click', async () => {
          setStatus('Submitting approval...');
          try {
            await complete('approved');
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Approval completion failed', true);
          }
        });
      }

      const denyButton = document.getElementById('deny-button');
      if (denyButton) {
        denyButton.addEventListener('click', denyWithoutAssertion);
      }

      const otpApproveButton = document.getElementById('otp-approve-button');
      if (otpApproveButton) {
        otpApproveButton.addEventListener('click', async () => {
          const otpInput = document.getElementById('otp-code');
          const code = otpInput && 'value' in otpInput ? otpInput.value.trim() : '';
          if (!/^\\d{6}$/.test(code)) {
            setStatus('Enter a valid 6-digit verification code.', true);
            return;
          }
          setStatus('Verifying code...');
          try {
            const assertionRes = await fetch(pageData.otpVerifyPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code })
            });
            const assertionPayload = await assertionRes.json().catch(() => ({}));
            if (!assertionRes.ok) {
              throw new Error(
                assertionPayload.error_description || assertionPayload.error || 'OTP verification failed'
              );
            }
            await complete('approved', assertionPayload.completion_assertion);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'OTP verification failed', true);
          }
        });
      }

      const otpDenyButton = document.getElementById('otp-deny-button');
      if (otpDenyButton) {
        otpDenyButton.addEventListener('click', denyWithoutAssertion);
      }

      const passkeyApproveButton = document.getElementById('passkey-approve-button');
      if (passkeyApproveButton) {
        passkeyApproveButton.addEventListener('click', async () => {
          if (!window.PublicKeyCredential || !navigator.credentials) {
            setStatus('This browser does not support passkey approval.', true);
            return;
          }
          setStatus('Preparing passkey challenge...');
          try {
            const optionsRes = await fetch(pageData.passkeyOptionsPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
            const optionsPayload = await optionsRes.json().catch(() => ({}));
            if (!optionsRes.ok) {
              throw new Error(
                optionsPayload.error_description || optionsPayload.error || 'Failed to prepare passkey challenge'
              );
            }
            const credential = await navigator.credentials.get({
              publicKey: decodePasskeyOptions(optionsPayload.options),
            });
            if (!credential) {
              throw new Error('Passkey approval was cancelled.');
            }
            const verifyRes = await fetch(pageData.passkeyVerifyPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                challenge_id: optionsPayload.challenge_id,
                credential: credentialToJSON(credential),
              }),
            });
            const verifyPayload = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok) {
              throw new Error(
                verifyPayload.error_description || verifyPayload.error || 'Passkey verification failed'
              );
            }
            await complete('approved', verifyPayload.completion_assertion);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Passkey approval failed', true);
          }
        });
      }

      const passkeyDenyButton = document.getElementById('passkey-deny-button');
      if (passkeyDenyButton) {
        passkeyDenyButton.addEventListener('click', denyWithoutAssertion);
      }

      const reauthApproveButton = document.getElementById('reauth-approve-button');
      if (reauthApproveButton) {
        reauthApproveButton.addEventListener('click', async () => {
          setStatus('Confirming current session...');
          try {
            const assertionRes = await fetch(pageData.reauthAssertPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
            const assertionPayload = await assertionRes.json().catch(() => ({}));
            if (!assertionRes.ok) {
              throw new Error(
                assertionPayload.error_description || assertionPayload.error || 'Reauthentication confirmation failed'
              );
            }
            await complete('approved', assertionPayload.completion_assertion);
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Reauthentication confirmation failed', true);
          }
        });
      }

      const reauthDenyButton = document.getElementById('reauth-deny-button');
      if (reauthDenyButton) {
        reauthDenyButton.addEventListener('click', denyWithoutAssertion);
      }

      const cibaStartButton = document.getElementById('ciba-start-button');
      if (cibaStartButton) {
        cibaStartButton.addEventListener('click', async () => {
          setStatus('Starting backchannel approval request...');
          try {
            const startRes = await fetch(pageData.cibaStartPath, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const startPayload = await startRes.json().catch(() => ({}));
            if (!startRes.ok) {
              throw new Error(startPayload.error_description || startPayload.error || 'Failed to start CIBA approval');
            }

            const deviceLink = startPayload.device_path ? '\\nAuthentication device: ' + startPayload.device_path : '';
            setStatus('CIBA request started. Check your registered email or phone for the verification code.' + deviceLink);

            const poll = async () => {
              const statusRes = await fetch(pageData.cibaStatusPath);
              const statusPayload = await statusRes.json().catch(() => ({}));
              if (!statusRes.ok) {
                return;
              }
              if (statusPayload.status === 'approved' && statusPayload.completion_assertion) {
                await complete('approved', statusPayload.completion_assertion);
                return;
              }
              if (statusPayload.status === 'denied') {
                setStatus('Authentication device denied the request.', true);
                return;
              }
              window.setTimeout(poll, Math.max(1000, (statusPayload.interval || 5) * 1000));
            };

            window.setTimeout(poll, Math.max(1000, (startPayload.interval || 5) * 1000));
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Failed to start CIBA approval', true);
          }
        });
      }

      const cibaDenyButton = document.getElementById('ciba-deny-button');
      if (cibaDenyButton) {
        cibaDenyButton.addEventListener('click', denyWithoutAssertion);
      }
    </script>
  </body>
</html>`;
}

export function renderApprovalCibaDevicePage(input: {
  artifactId: string;
  request: ApprovalArtifactPortalRequestView;
  approval: ApprovalArtifactPortalApprovalView & {
    subject_id?: string | null;
    transport_channel?: string | null;
  };
}) {
  const { artifactId, request, approval } = input;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authrim Authentication Device</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      .shell { max-width: 720px; margin: 48px auto; padding: 24px; }
      .card { background: #111b34; border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 18px; padding: 24px; }
      h1 { margin: 0 0 10px; font-size: 1.8rem; }
      p { line-height: 1.55; color: #cbd5e1; }
      code { background: rgba(148, 163, 184, 0.14); padding: 2px 6px; border-radius: 6px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
      button { border: 0; border-radius: 999px; padding: 12px 20px; font-weight: 700; cursor: pointer; }
      .approve { background: #14b86a; color: #04120a; }
      .deny { background: #fb7185; color: #2f0c15; }
      .status { margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: rgba(15, 23, 42, 0.6); white-space: pre-wrap; }
      .status.error { background: rgba(127, 29, 29, 0.5); }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <h1>Authentication device approval</h1>
        <p>Confirm or deny the approval request below from the authentication device.</p>
        <p><strong>Investigation:</strong> ${escapeHtml(request.investigation_id)}</p>
        <p><strong>Surface:</strong> ${escapeHtml(request.request_surface)} / ${escapeHtml(request.requested_action)}</p>
        <p><strong>Step:</strong> ${escapeHtml(approval.step_key)}</p>
        <p><strong>Approver binding:</strong> <code>${escapeHtml(approval.subject_id ?? approval.transport_channel ?? 'unbound')}</code></p>
        <p>Enter the verification code delivered out-of-band before recording the decision.</p>
        <p><label for="user-code"><strong>Verification code</strong></label></p>
        <p><input id="user-code" name="user_code" inputmode="text" autocomplete="one-time-code" maxlength="32" style="width:100%;max-width:240px;font-size:1rem;padding:10px 12px;border-radius:10px;border:1px solid rgba(148,163,184,.4);background:#0f172a;color:#e2e8f0;" /></p>
        <div class="actions">
          <button class="approve" id="approve-button">Approve</button>
          <button class="deny" id="deny-button">Deny</button>
        </div>
        <div class="status" id="status-box">Ready.</div>
      </div>
    </div>
    <script>
      const statusBox = document.getElementById('status-box');
      const setStatus = (message, isError = false) => {
        statusBox.textContent = message;
        statusBox.classList.toggle('error', isError);
      };
      async function respond(decision) {
        setStatus('Submitting ' + decision + '...');
        try {
          const authReqId = new URLSearchParams(window.location.search).get('auth_req_id');
          const userCode = document.getElementById('user-code').value.trim();
          if (!authReqId) {
            throw new Error('Missing auth_req_id for this authentication device session.');
          }
          if (!userCode) {
            throw new Error('Verification code is required.');
          }
          const res = await fetch('/api/approval-artifacts/${encodeURIComponent(artifactId)}/ciba/respond', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, auth_req_id: authReqId, user_code: userCode })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload.error_description || payload.error || 'Failed to submit decision');
          }
          setStatus('Decision recorded: ' + payload.status + '\\nAuth request ID: ' + payload.auth_req_id);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : 'Failed to submit decision', true);
        }
      }
      document.getElementById('approve-button').addEventListener('click', () => respond('approved'));
      document.getElementById('deny-button').addEventListener('click', () => respond('denied'));
    </script>
  </body>
</html>`;
}
