import type { ApprovalDecisionReceipt } from '@authrim/ar-lib-core';

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function renderApprovalDecisionReceiptPage(input: {
  receipt: ApprovalDecisionReceipt;
}): string {
  const { receipt } = input;
  const grantSummary = receipt.grant_ids.length ? receipt.grant_ids.join(', ') : 'None';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authrim Approval Receipt</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f4f6fb; color: #132033; }
      .shell { max-width: 760px; margin: 48px auto; padding: 24px; }
      .card { background: white; border-radius: 18px; padding: 24px; box-shadow: 0 24px 60px rgba(16, 24, 40, 0.08); }
      h1 { margin: 0 0 8px; font-size: 1.75rem; }
      p { line-height: 1.55; }
      dl { display: grid; grid-template-columns: 180px 1fr; gap: 10px 16px; margin: 24px 0; }
      dt { font-weight: 700; color: #3a4a63; }
      dd { margin: 0; word-break: break-word; }
      .badge { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 10px 16px; font-weight: 700; }
      .badge.approved { background: #dff6ea; color: #0f6c45; }
      .badge.denied { background: #fee4e2; color: #b42318; }
      code { background: #eef2ff; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <h1>Approval decision recorded</h1>
        <p>Your approval step has been recorded. Keep this receipt ID for audit or support follow-up.</p>
        <div class="badge ${escapeHtml(receipt.decision)}">${escapeHtml(receipt.decision.toUpperCase())}</div>
        <dl>
          <dt>Receipt ID</dt><dd><code>${escapeHtml(receipt.receipt_id)}</code></dd>
          <dt>Investigation</dt><dd>${escapeHtml(receipt.investigation_id)}</dd>
          <dt>Request ID</dt><dd>${escapeHtml(receipt.request_id)}</dd>
          <dt>Approval Step</dt><dd>${escapeHtml(receipt.step_key)}</dd>
          <dt>Surface</dt><dd>${escapeHtml(receipt.request_surface)}</dd>
          <dt>Action</dt><dd>${escapeHtml(receipt.requested_action)}</dd>
          <dt>Method</dt><dd>${escapeHtml(receipt.method)}</dd>
          <dt>Request Status</dt><dd>${escapeHtml(receipt.request_status)}</dd>
          <dt>Completed At</dt><dd>${escapeHtml(formatDateTime(receipt.completed_at))}</dd>
          <dt>Receipt Expires</dt><dd>${escapeHtml(formatDateTime(receipt.expires_at))}</dd>
          <dt>Grant IDs</dt><dd>${escapeHtml(grantSummary)}</dd>
        </dl>
      </div>
    </div>
  </body>
</html>`;
}
