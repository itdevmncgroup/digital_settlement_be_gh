import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { ExpenseStatus } from '@prisma/client';
import { RoleName } from 'src/common/constants/role-name';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_INVOICE_MIME_TYPES = [...ALLOWED_PHOTO_MIME_TYPES, 'application/pdf'];
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_INVOICE_FILES = 10;

// Invoice files + Foto Product for the Expense Request "Add / Update Invoice" uploads.
const FromRequestUploadInterceptor = FileFieldsInterceptor(
  [
    { name: 'files', maxCount: MAX_INVOICE_FILES },
    { name: 'photos', maxCount: MAX_INVOICE_FILES },
  ],
  {
    storage: memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
    fileFilter: (_req, file, cb) => {
      // Foto Product must be an image; invoices may also be PDF.
      const allowed = file.fieldname === 'photos' ? ALLOWED_PHOTO_MIME_TYPES : ALLOWED_INVOICE_MIME_TYPES;
      if (!allowed.includes(file.mimetype)) {
        return cb(new Error('Unsupported file type'), false);
      }
      cb(null, true);
    },
  },
);

// Post-Event Expense (BRD section 9, 28, BR-001..BR-015)
@Controller('expenses')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  @Get()
  findAll(
    @CurrentUser() actor: AuthUser,
    @Query('status') status?: ExpenseStatus | 'ALL',
    @Query('salesId') salesId?: string,
    @Query('unitId') unitId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('matched') matched?: 'MATCHED' | 'UNMATCHED',
    @Query('search') search?: string,
  ) {
    return this.service.findAll(actor, { status, salesId, unitId, departmentId, fromDate, toDate, matched, search });
  }

  @Get('export/xlsx')
  async exportXlsx(
    @CurrentUser() actor: AuthUser,
    @Res() res: Response,
    @Query('status') status?: ExpenseStatus | 'ALL',
    @Query('salesId') salesId?: string,
    @Query('unitId') unitId?: string,
    @Query('departmentId') departmentId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('matched') matched?: 'MATCHED' | 'UNMATCHED',
    @Query('search') search?: string,
  ) {
    const buffer = await this.service.exportWorkbook(actor, { status, salesId, unitId, departmentId, fromDate, toDate, matched, search });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="expenses-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buffer);
  }

  // Users selectable as requestor when keying an Expense in on their behalf (see
  // ExpensesService.listRequestors). Declared before ':id' so it isn't read as an id.
  @Get('requestors')
  @Roles(RoleName.ADMIN)
  @RequirePermission('expense.create.all', 'expense.create.own', 'expense.create.owndept')
  listRequestors(@CurrentUser() actor: AuthUser) {
    return this.service.listRequestors(actor.userId, actor.roles, actor.permissions ?? []);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.SALES, RoleName.ADMIN)
  @RequirePermission('expense.create.all', 'expense.create.own', 'expense.create.owndept')
  create(@Body() dto: CreateExpenseDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId, actor.roles, actor.permissions);
  }

  // Corsec only (checked by Position in the service, like POST / with expenseRequestId).
  @Post('from-request/:requestId')
  @UseInterceptors(FromRequestUploadInterceptor)
  createFromRequestWithInvoices(
    @Param('requestId') requestId: string,
    @UploadedFiles() uploaded: { files?: Express.Multer.File[]; photos?: Express.Multer.File[] },
    @Body('merchantName') merchantName: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.createFromExpenseRequestWithInvoices(
      requestId,
      uploaded?.files ?? [],
      uploaded?.photos ?? [],
      merchantName?.trim() || undefined,
      actor.userId,
      actor.roles,
    );
  }

  // "Update Invoice": after a Sales Admin sent the Request's Expense back (REVISION), Corsec
  // replaces its invoice files here and the Expense returns to that Sales Admin's tier.
  @Patch('from-request/:requestId')
  @UseInterceptors(FromRequestUploadInterceptor)
  updateInvoicesFromRequest(
    @Param('requestId') requestId: string,
    @UploadedFiles() uploaded: { files?: Express.Multer.File[]; photos?: Express.Multer.File[] },
    @Body('merchantName') merchantName: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.updateInvoicesFromExpenseRequest(
      requestId,
      uploaded?.files ?? [],
      uploaded?.photos ?? [],
      merchantName?.trim() || undefined,
      actor.userId,
      actor.roles,
    );
  }

  // SALES_ADMIN is admitted only to complete a PENDING_SALES_ADMIN Expense - the
  // service (assertCanEdit, routeGate) rejects it for anything else.
  @Patch(':id')
  @Roles(RoleName.SALES, RoleName.SALES_ADMIN, RoleName.ADMIN)
  @RequirePermission('expense.edit.all', 'expense.edit.own', 'expense.create.all', 'expense.create.own', 'expense.create.owndept')
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId, actor.roles, actor.permissions);
  }

  @Post(':id/submit')
  @Roles(RoleName.SALES, RoleName.SALES_ADMIN, RoleName.ADMIN)
  @RequirePermission('expense.edit.all', 'expense.edit.own', 'expense.create.all', 'expense.create.own', 'expense.create.owndept')
  submitDraft(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.submitDraft(id, actor.userId, actor.roles, actor.permissions);
  }

  @Post(':id/resend-approval-email')
  resendApprovalEmail(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.resendApprovalEmail(id, actor.userId, actor.roles, actor.permissions);
  }

  @Post(':id/photos')
  @Roles(RoleName.SALES, RoleName.ADMIN)
  @RequirePermission('expense.create.all', 'expense.create.own', 'expense.create.owndept')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.mimetype)) {
          return cb(new Error('Unsupported file type'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadPhoto(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() actor: AuthUser) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.service.addPhoto(id, file, actor.userId, actor.roles, actor.permissions);
  }

  @Get('photos/:photoId/download')
  async downloadPhoto(@Param('photoId') photoId: string, @CurrentUser() actor: AuthUser, @Res() res: Response) {
    const photo = await this.service.getPhotoForDownload(photoId, actor);
    res.setHeader('Content-Disposition', `attachment; filename="${photo.fileName}"`);
    res.setHeader('Content-Type', photo.mimeType);
    res.send(photo.buffer);
  }
}
