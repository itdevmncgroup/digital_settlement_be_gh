import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ExpenseStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { StorageService } from '../common/storage/storage.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { canAccessExpenseOwnedRecord } from '../common/rbac/scope.util';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';

const include = { merchant: true, files: true, modifiedBy: { select: { id: true, name: true } } } as const;
const EDITABLE_STATUSES: ExpenseStatus[] = [ExpenseStatus.DRAFT, ExpenseStatus.REJECTED, ExpenseStatus.REVISION];

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async findOne(id: string, actor: AuthUser) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { ...include, expense: { select: { id: true, expenseNo: true, salesId: true, podId: true } } },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.assertCanAccess(invoice.expense, actor);
    return invoice;
  }

  async createForExpense(expenseId: string, dto: CreateInvoiceDto, actorId: string, actorRoles: string[] = []) {
    const expense = await this.getEditableExpenseOrThrow(expenseId, actorId, actorRoles);

    const invoice = await this.prisma.invoice.create({
      data: {
        expenseId: expense.id,
        invoiceNumber: dto.invoiceNumber,
        invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : undefined,
        merchantId: dto.merchantId,
        finalMerchantName: dto.finalMerchantName,
        finalSubtotal: dto.finalSubtotal,
        finalTax: dto.finalTax,
        finalServiceCharge: dto.finalServiceCharge,
        finalDiscount: dto.finalDiscount,
        finalTotal: dto.finalTotal,
        ocrMerchantName: dto.ocrMerchantName,
        ocrSubtotal: dto.ocrSubtotal,
        ocrTax: dto.ocrTax,
        ocrServiceCharge: dto.ocrServiceCharge,
        ocrDiscount: dto.ocrDiscount,
        ocrTotal: dto.ocrTotal,
        ocrConfidence: dto.ocrConfidence,
        modifiedById: actorId,
        modifiedAt: new Date(),
      },
      include,
    });

    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Invoice', objectId: invoice.id, newValue: invoice });
    return invoice;
  }

  // BRD section 21 - Invoice Data Integrity: OCR value is never overwritten,
  // only final_* + modifiedBy/modifiedAt change here.
  async update(id: string, dto: UpdateInvoiceDto, actorId: string, actorRoles: string[] = []) {
    const before = await this.prisma.invoice.findUnique({ where: { id }, include: { expense: true } });
    if (!before) throw new NotFoundException('Invoice not found');
    await this.getEditableExpenseOrThrow(before.expenseId, actorId, actorRoles);

    const invoice = await this.prisma.invoice.update({
      where: { id },
      data: {
        invoiceNumber: dto.invoiceNumber,
        invoiceDate: dto.invoiceDate ? new Date(dto.invoiceDate) : undefined,
        merchantId: dto.merchantId,
        finalMerchantName: dto.finalMerchantName,
        finalSubtotal: dto.finalSubtotal,
        finalTax: dto.finalTax,
        finalServiceCharge: dto.finalServiceCharge,
        finalDiscount: dto.finalDiscount,
        finalTotal: dto.finalTotal,
        modifiedById: actorId,
        modifiedAt: new Date(),
      },
      include,
    });

    await this.audit.log({
      userId: actorId,
      action: 'MANUAL_CORRECTION',
      objectType: 'Invoice',
      objectId: id,
      oldValue: before,
      newValue: invoice,
    });
    return invoice;
  }

  async addFile(invoiceId: string, file: Express.Multer.File, fileType: 'ORIGINAL' | 'PROCESSED', actorId: string, actorRoles: string[] = []) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { expense: true } });
    if (!invoice) throw new NotFoundException('Invoice not found');
    await this.getEditableExpenseOrThrow(invoice.expenseId, actorId, actorRoles);

    const stored = await this.storage.save(file.buffer, `invoice/${invoice.expenseId}`, file.originalname);

    const invoiceFile = await this.prisma.invoiceFile.create({
      data: {
        invoiceId,
        fileType,
        storageKey: stored.storageKey,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: stored.size,
        checksum: stored.checksum,
      },
    });

    await this.audit.log({ userId: actorId, action: 'UPLOAD', objectType: 'InvoiceFile', objectId: invoiceFile.id, newValue: invoiceFile });
    return invoiceFile;
  }

  async getFileForDownload(fileId: string, actor: AuthUser) {
    const file = await this.prisma.invoiceFile.findUnique({
      where: { id: fileId },
      include: { invoice: { include: { expense: { select: { salesId: true, podId: true } } } } },
    });
    if (!file) throw new NotFoundException('File not found');
    await this.assertCanAccess(file.invoice.expense, actor);

    await this.audit.log({ userId: actor.userId, action: 'DOWNLOAD', objectType: 'InvoiceFile', objectId: file.id });

    return { path: this.storage.resolvePath(file.storageKey), fileName: file.fileName, mimeType: file.mimeType };
  }

  private async assertCanAccess(owner: { salesId: string; podId?: string | null }, actor: AuthUser) {
    if (!(await canAccessExpenseOwnedRecord(this.prisma, actor, owner))) {
      throw new ForbiddenException('Not authorized to access this invoice');
    }
  }

  private async getEditableExpenseOrThrow(expenseId: string, actorId: string, actorRoles: string[] = []) {
    const expense = await this.prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.salesId !== actorId && !this.isBackOffice(actorRoles)) {
      throw new ForbiddenException('Not owner of this expense');
    }
    if (!EDITABLE_STATUSES.includes(expense.status)) {
      throw new BadRequestException(`Expense in status ${expense.status} cannot be modified`);
    }
    return expense;
  }

  private isBackOffice(actorRoles: string[]): boolean {
    return actorRoles.some((r) => r === 'ADMIN' || r === 'FINANCE');
  }
}
