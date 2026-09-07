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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { RoleName } from 'src/common/constants/role-name';
import { InvoicesService } from './invoices.service';
import { OcrService } from '../ocr/ocr.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

// Invoice - manual entry, pre-fillable via Tesseract.js OCR scan (BRD section 10-12, 15, 21, 29)
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(
    private readonly service: InvoicesService,
    private readonly ocr: OcrService,
  ) {}

  // Stateless receipt scan: no Expense/Invoice needs to exist yet - called right
  // after the user picks a receipt image on the create-expense form, so the
  // parsed items/totals can pre-fill the form before anything is saved.
  @Post('invoices/ocr-scan')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
          return cb(new Error('Unsupported file type - OCR scan only accepts images'), false);
        }
        cb(null, true);
      },
    }),
  )
  ocrScan(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.ocr.scan(file.buffer);
  }

  @Post('expenses/:expenseId/invoices')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  create(@Param('expenseId') expenseId: string, @Body() dto: CreateInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.service.createForExpense(expenseId, dto, actor.userId, actor.roles);
  }

  @Get('invoices/:id')
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.findOne(id, actor);
  }

  @Patch('invoices/:id')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  update(@Param('id') id: string, @Body() dto: UpdateInvoiceDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId, actor.roles);
  }

  @Post('invoices/:id/files')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
          return cb(new Error('Unsupported file type'), false);
        }
        cb(null, true);
      },
    }),
  )
  uploadFile(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('fileType') fileType: 'ORIGINAL' | 'PROCESSED' = 'ORIGINAL',
    @CurrentUser() actor: AuthUser,
  ) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.service.addFile(id, file, fileType, actor.userId, actor.roles);
  }

  @Get('invoices/files/:fileId/download')
  async download(@Param('fileId') fileId: string, @CurrentUser() actor: AuthUser, @Res() res: Response) {
    const file = await this.service.getFileForDownload(fileId, actor);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Type', file.mimeType);
    res.sendFile(file.path);
  }
}
