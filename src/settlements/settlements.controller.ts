import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { RoleName } from 'src/common/constants/role-name';
import { SettlementsService } from './settlements.service';
import {
  AddExpensesToSettlementDto,
  CreateSettlementDto,
  CreateSettlementFromSelectionDto,
  GenerateSettlementDto,
  SendDraftPrDto,
  UpdateSettlementDto,
} from './dto/settlement.dto';
import { ApprovalsService } from '../approvals/approvals.service';
import { RejectDto } from '../approvals/dto/reject.dto';
import { ReviseDto } from '../approvals/dto/revise.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const MAX_STATEMENT_SIZE_BYTES = 20 * 1024 * 1024;

// Optional bank statement PDF on :id/pdf and :id/draft-pr/send.
const statementUploadOptions: MulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_STATEMENT_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new BadRequestException('Bank statement must be a PDF file'), false);
    cb(null, true);
  },
};

// Create Settlement (BRD "Create Settlement" on the Expense page) - bundles a
// Department's bank-matched Expenses into one Settlement with a STL-YYMMDD#### id.
@Controller('settlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.SALES, RoleName.ADMIN, RoleName.MANAGEMENT)
export class SettlementsController {
  constructor(
    private readonly service: SettlementsService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  @RequirePermission('settlement.read.owndept', 'settlement.read.all')
  findAll(@CurrentUser() actor: AuthUser, @Query('departmentId') departmentId?: string) {
    return this.service.findAll(actor, departmentId);
  }

  @Get(':id')
  @RequirePermission('settlement.read.owndept', 'settlement.read.all')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermission('settlement.create.owndept')
  create(@Body() dto: CreateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(actor.userId, actor.roles, dto.salesId);
  }

  // Settlement page's "Create Settlement" popup - preview-only (one Department
  // + one date range, no writes); the page's Submit step commits via
  // from-selection ("Buat baru") or :id/expenses ("Tambahkan", when a DRAFT
  // settlement already covers this Department).
  @Post('generate')
  @RequirePermission('settlement.create.owndept')
  generate(@Body() dto: GenerateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.generate(
      dto.departmentId,
      dto.fromDate,
      dto.toDate,
      dto.paymentMethodGroup,
      actor.userId,
      actor.roles,
      dto.creditCardId,
      dto.activityTypeIds,
    );
  }

  // "Buat baru" - commits the checked subset from the generate-preview table
  // as a brand-new Settlement.
  @Post('from-selection')
  @RequirePermission('settlement.create.owndept')
  createFromSelection(@Body() dto: CreateSettlementFromSelectionDto, @CurrentUser() actor: AuthUser) {
    return this.service.createFromSelection(
      dto.departmentId,
      dto.expenseIds,
      dto.paymentMethodGroup,
      actor.userId,
      actor.roles,
      dto.allocations,
      dto.creditCardId,
    );
  }

  @Get(':id/eligible-expenses')
  @RequirePermission('settlement.create.owndept')
  eligibleExpenses(@Param('id') id: string) {
    return this.service.eligibleExpenses(id);
  }

  @Post(':id/expenses')
  @RequirePermission('settlement.create.owndept')
  addExpenses(@Param('id') id: string, @Body() dto: AddExpensesToSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.addExpenses(id, dto.expenseIds, actor.userId, actor.roles);
  }

  // Settlement list's "Edit" button on a DRAFT_SETTLEMENT row - replaces the
  // member Expenses and allocation rows.
  @Patch(':id')
  @RequirePermission('settlement.create.owndept')
  update(@Param('id') id: string, @Body() dto: UpdateSettlementDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto.expenseIds, dto.allocations, actor.userId, actor.roles);
  }

  @Post(':id/complete')
  @Roles(RoleName.ADMIN)
  complete(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.complete(id, actor.userId);
  }

  // Manual retry for a Settlement whose push to Odoo FAILED - same role as
  // :id/complete above, since both are back-office/bookkeeping actions.
  @Post(':id/retry-sync')
  @Roles(RoleName.ADMIN)
  retrySync(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.retrySync(id, actor.userId);
  }

  // Settlement list's "Create Draft PR" popup: pick a Unit, Preview the
  // allocation lines, then Send To Odoo. Gated in the service by the
  // settlement.send.odoo.all / .owndept permissions (or Admin), not by role -
  // same pattern as the approver endpoints below.
  @Get(':id/draft-pr/preview')
  @Roles()
  previewDraftPr(@Param('id') id: string, @Query('unitId') unitId: string, @CurrentUser() actor: AuthUser) {
    return this.service.previewDraftPr(id, unitId, actor);
  }

  // PDF attachment for the Draft PR (Form Jamuan table, bank statement pages,
  // activity photos / invoices) - same gate as the Draft PR actions above.
  // The optional multipart `file` is the bank statement PDF picked in the popup;
  // all of its pages are inserted after the Form Jamuan pages. Without it, no
  // bank statement pages are included at all.
  @Post(':id/pdf')
  @Roles()
  @UseInterceptors(FileInterceptor('file', statementUploadOptions))
  async generatePdf(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
    @Res() res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.sendPdf(res, await this.service.generatePdf(id, actor, file?.buffer));
  }

  @Get(':id/pdf')
  @Roles()
  async downloadPdf(@Param('id') id: string, @CurrentUser() actor: AuthUser, @Res() res: Response) {
    return this.sendPdf(res, await this.service.generatePdf(id, actor));
  }

  private sendPdf(res: Response, { buffer, fileName }: { buffer: Buffer; fileName: string }) {
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(buffer);
  }

  // Multipart: `unitId` + the same optional `file` (bank statement PDF) as :id/pdf.
  @Post(':id/draft-pr/send')
  @Roles()
  @UseInterceptors(FileInterceptor('file', statementUploadOptions))
  sendDraftPr(
    @Param('id') id: string,
    @Body() dto: SendDraftPrDto,
    @CurrentUser() actor: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.sendDraftPr(id, dto.unitId, actor, file?.buffer);
  }

  // Settlement list's "Submit" button on a DRAFT_SETTLEMENT row - starts the
  // batch's own approval chain (SLS_MAR_DIR -> VP -> CO_CFO). Distinct from
  // :id/submit below, which is the per-tier approver's Submit once the chain
  // is already running.
  @Post(':id/submit-draft')
  @RequirePermission('settlement.create.owndept')
  submitDraft(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.submitDraft(id, actor.userId, actor.roles);
  }

  // The Settlement approval tier (SLS_MAR_DIR -> VP -> CO_CFO): its approver
  // signs off each member Expense, then submits to close the tier. Authorization
  // is the resolved approver of the current step (or ADMIN), checked in the
  // service - not role-based, same as the Expense approval endpoints.
  @Post(':id/expenses/:expenseId/approve')
  @Roles()
  approveExpense(@Param('id') id: string, @Param('expenseId') expenseId: string, @CurrentUser() actor: AuthUser) {
    return this.approvals.reviewSettlementExpense({ settlementId: id, expenseId, approve: true }, actor);
  }

  @Post(':id/expenses/:expenseId/reject')
  @Roles()
  rejectExpense(
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
    @Body() dto: RejectDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.approvals.reviewSettlementExpense({ settlementId: id, expenseId, approve: false, reason: dto.reason }, actor);
  }

  @Post(':id/submit')
  @Roles()
  submit(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.approvals.submitSettlementTier(id, actor);
  }

  // Sends the whole batch back exactly one tier instead of Submit/Reject - see
  // ApprovalsService.reviseSettlementTier. Whole-settlement scope, same as
  // submit above (a per-expense revise would leave the batch half-reviewed
  // with no defined resume semantics).
  @Post(':id/revise')
  @Roles()
  revise(@Param('id') id: string, @Body() dto: ReviseDto, @CurrentUser() actor: AuthUser) {
    return this.approvals.reviseSettlementTier(id, dto.reason, actor);
  }
}
