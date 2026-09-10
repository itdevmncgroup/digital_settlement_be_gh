import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { RoleName } from 'src/common/constants/role-name';
import { BankMatchingService } from './bank-matching.service';
import { ManualMatchDto } from './dto/bank-matching.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;

// Auto Matching - reconcile Expenses against a bank/credit-card settlement PDF
// uploaded by Finance (BRD AutoMatching menu).
@Controller('bank-settlements')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.FINANCE, RoleName.ADMIN, RoleName.MANAGEMENT)
export class BankMatchingController {
  constructor(private readonly service: BankMatchingService) {}

  @Get()
  findAll() {
    return this.service.findAllBatches();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findBatch(id);
  }

  // Backs the "Matched" picker on the Expense detail page - Finance/Admin
  // search bank transactions (any batch) to manually link one to an Expense.
  @Get('transactions/search')
  searchTransactions(@Query('search') search?: string, @Query('unmatchedOnly') unmatchedOnly?: string) {
    return this.service.searchTransactions(search, unmatchedOnly === 'true');
  }

  @Post()
  @RequirePermission('expense.automatch')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
          return cb(new Error('Only PDF files are supported'), false);
        }
        cb(null, true);
      },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() actor: AuthUser,
    @Query('force') force?: string,
  ) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.service.uploadAndMatch(file, actor.userId, force === 'true');
  }

  // "TIDAK" branch of the web page's already-scanned prompt: re-run matching
  // against current Expense data using this batch's already-parsed lines,
  // without re-uploading/re-parsing the file.
  @Post(':id/rematch')
  @RequirePermission('expense.automatch')
  rematch(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.rematch(id, actor.userId);
  }

  @Post('transactions/:id/match')
  @RequirePermission('expense.match.all', 'expense.match.ownpod')
  match(@Param('id') id: string, @Body() dto: ManualMatchDto, @CurrentUser() actor: AuthUser) {
    return this.service.manualMatch(id, dto.expenseId, actor);
  }

  @Post('transactions/:id/unmatch')
  @RequirePermission('expense.match.all', 'expense.match.ownpod')
  unmatch(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.service.unmatch(id, actor);
  }

  // "Manual, no billing statement" match/unmatch - backs the Expense detail
  // page's "Matched (no statement)" option for spend that never appears on a
  // bank/credit-card statement (e-wallet, personal cash pending reimbursement).
  @Post('expenses/:expenseId/manual-match')
  @RequirePermission('expense.match.all', 'expense.match.ownpod')
  manualMatchExpense(@Param('expenseId') expenseId: string, @CurrentUser() actor: AuthUser) {
    return this.service.manualMatchExpense(expenseId, actor);
  }

  @Post('expenses/:expenseId/manual-unmatch')
  @RequirePermission('expense.match.all', 'expense.match.ownpod')
  manualUnmatchExpense(@Param('expenseId') expenseId: string, @CurrentUser() actor: AuthUser) {
    return this.service.manualUnmatchExpense(expenseId, actor);
  }
}
