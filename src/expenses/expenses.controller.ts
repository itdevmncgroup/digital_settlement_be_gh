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
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

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

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  @RequirePermission('expense.create.all', 'expense.create.owndept')
  create(@Body() dto: CreateExpenseDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId, actor.roles, actor.permissions);
  }

  @Patch(':id')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  @RequirePermission('expense.edit.all')
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId, actor.roles, actor.permissions);
  }

  @Post(':id/photos')
  @Roles(RoleName.SALES, RoleName.ADMIN, RoleName.FINANCE)
  @RequirePermission('expense.create.all', 'expense.create.owndept')
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
    res.sendFile(photo.path);
  }
}
