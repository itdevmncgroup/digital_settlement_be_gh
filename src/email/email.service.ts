import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface ApprovalEmailParams {
  to: string;
  approverName: string;
  positionName: string;
  documentStage: 'PRE_EVENT' | 'EXPENSES' | 'SETTLEMENT';
  docNo: string;
  salesName: string;
  purpose: string;
  amount: string;
  approveUrl: string;
  rejectUrl: string;
}

export interface SettlementApprovalNoticeParams {
  to: string;
  approverName: string;
  positionName: string;
  settlementNo: string;
  departmentName: string;
  createdByName: string;
  totalAmount: string;
  openUrl: string;
  expenses: { expenseNo: string; salesName: string; purpose: string; amount: string }[];
}

// Approval-via-email (one-click token links). Fire-and-forget by design: a
// failed send must never block or roll back the approval workflow itself -
// callers wrap sendApprovalRequest in try/catch and just log on failure, the
// in-app approval flow (approvals inbox, detail pages) always still works.
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get<string>('SMTP_HOST') || 'localhost',
      port: Number(this.config.get<string>('SMTP_PORT')) || 25,
      secure: this.config.get<string>('SMTP_SECURE') === 'true',
      auth:
        this.config.get<string>('SMTP_USER')
          ? { user: this.config.get<string>('SMTP_USER'), pass: this.config.get<string>('SMTP_PASS') }
          : undefined,
    });
  }

  async sendApprovalRequest(params: ApprovalEmailParams): Promise<void> {
    const stageLabel = params.documentStage === 'PRE_EVENT' ? 'Pre-Event' : params.documentStage === 'EXPENSES' ? 'Expenses' : 'Settlement';
    const subject = `Approval needed: ${params.docNo} - ${params.positionName} (${stageLabel})`;
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1d23;max-width:520px">
        <p>Hi ${escapeHtml(params.approverName)},</p>
        <p>A ${stageLabel} request needs your approval as <strong>${escapeHtml(params.positionName)}</strong>:</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Document No</td><td><strong>${escapeHtml(params.docNo)}</strong></td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Sales</td><td>${escapeHtml(params.salesName)}</td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Purpose</td><td>${escapeHtml(params.purpose)}</td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Amount</td><td>${escapeHtml(params.amount)}</td></tr>
        </table>
        <p>
          <a href="${params.approveUrl}" style="display:inline-block;background:#2fb344;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;margin-right:8px">Approve</a>
          <a href="${params.rejectUrl}" style="display:inline-block;background:#d63939;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Reject</a>
        </p>
        <p style="color:#6b7280;font-size:12px">This link is single-use and expires after a while. If you weren't expecting this, you can ignore it.</p>
      </div>
    `;

    const info = await this.transporter.sendMail({
      from: this.config.get<string>('SMTP_FROM') || 'SCE Expense <noreply@sce-expense.local>',
      to: params.to,
      subject,
      html,
    });
    this.logger.log(`Approval email sent to ${params.to} (messageId=${info.messageId})`);
  }

  // Settlement chain notice: unlike sendApprovalRequest, this is not a
  // one-click approve/reject link - a Settlement tier requires the approver
  // to review every member Expense individually before submitting the batch
  // (see approvals.service.ts submitSettlementTier), so a blind email click
  // can't stand in for that. The single button just opens the settlement
  // (mobile app via App Link if installed, browser otherwise).
  async sendSettlementApprovalNotice(params: SettlementApprovalNoticeParams): Promise<void> {
    const subject = `Settlement awaiting your approval: ${params.settlementNo} - ${params.positionName}`;
    const expenseRows = params.expenses
      .map(
        (e) => `
          <tr>
            <td style="border-bottom:1px solid #e5e7eb;padding:4px 8px 4px 0">${escapeHtml(e.expenseNo)}</td>
            <td style="border-bottom:1px solid #e5e7eb;padding:4px 8px">${escapeHtml(e.salesName)}</td>
            <td style="border-bottom:1px solid #e5e7eb;padding:4px 8px">${escapeHtml(e.purpose)}</td>
            <td style="border-bottom:1px solid #e5e7eb;padding:4px 0 4px 8px;text-align:right">${escapeHtml(e.amount)}</td>
          </tr>`,
      )
      .join('');
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1d23;max-width:640px">
        <p>Hi ${escapeHtml(params.approverName)},</p>
        <p>A Settlement batch needs your review as <strong>${escapeHtml(params.positionName)}</strong>:</p>
        <table style="border-collapse:collapse;margin:12px 0">
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Settlement No</td><td><strong>${escapeHtml(params.settlementNo)}</strong></td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Department</td><td>${escapeHtml(params.departmentName)}</td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Created By</td><td>${escapeHtml(params.createdByName)}</td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Total Amount</td><td>${escapeHtml(params.totalAmount)}</td></tr>
          <tr><td style="color:#6b7280;padding:2px 12px 2px 0">Expense Count</td><td>${params.expenses.length}</td></tr>
        </table>
        <p style="margin-bottom:4px"><strong>Expenses in this batch</strong></p>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:2px solid #d1d5db;padding:2px 8px 4px 0">Expense No</th>
              <th style="text-align:left;border-bottom:2px solid #d1d5db;padding:2px 8px 4px 8px">Sales</th>
              <th style="text-align:left;border-bottom:2px solid #d1d5db;padding:2px 8px 4px 8px">Purpose</th>
              <th style="text-align:right;border-bottom:2px solid #d1d5db;padding:2px 0 4px 8px">Amount</th>
            </tr>
          </thead>
          <tbody>${expenseRows}</tbody>
        </table>
        <p style="margin-top:16px">
          <a href="${params.openUrl}" style="display:inline-block;background:#2f6fed;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Settlement</a>
        </p>
        <p style="color:#6b7280;font-size:12px">Review each expense in the batch, then submit to advance it to the next tier.</p>
      </div>
    `;

    const info = await this.transporter.sendMail({
      from: this.config.get<string>('SMTP_FROM') || 'SCE Expense <noreply@sce-expense.local>',
      to: params.to,
      subject,
      html,
    });
    this.logger.log(`Settlement approval notice sent to ${params.to} (messageId=${info.messageId})`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
