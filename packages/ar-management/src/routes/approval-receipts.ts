import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { createErrorResponse, AR_ERROR_CODES, getTenantIdFromContext } from '@authrim/ar-lib-core';
import { getApprovalDecisionReceipt } from '../approval-completion-receipt';
import { renderApprovalDecisionReceiptPage } from '../approval-decision-receipt-page';

export const approvalReceiptsRouter = new Hono<{ Bindings: Env }>();

approvalReceiptsRouter.get('/:receiptId', async (c) => {
  try {
    const receipt = await getApprovalDecisionReceipt(
      c.env,
      c.req.param('receiptId')!,
      getTenantIdFromContext(c)
    );
    if (!receipt) {
      return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    }

    return c.json({
      ...receipt,
      receipt_path: `/api/approval-receipts/${receipt.receipt_id}`,
      receipt_portal_path: `/api/approval-receipts/${receipt.receipt_id}/portal`,
    });
  } catch {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

approvalReceiptsRouter.get('/:receiptId/portal', async (c) => {
  try {
    const receipt = await getApprovalDecisionReceipt(
      c.env,
      c.req.param('receiptId')!,
      getTenantIdFromContext(c)
    );
    if (!receipt) {
      return new Response('Approval receipt not found or expired.', { status: 404 });
    }

    return new Response(renderApprovalDecisionReceiptPage({ receipt }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response('Internal server error', { status: 500 });
  }
});
