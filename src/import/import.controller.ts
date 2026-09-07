import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { RoleName } from 'src/common/constants/role-name';
import { ImportEntityType, ImportService } from './import.service';
import { CommitImportDto } from './dto/commit-import.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

const VALID_ENTITY_TYPES: ImportEntityType[] = ['AGENCY', 'ADVERTISER', 'BRAND', 'MERCHANT'];
const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

function assertEntityType(entityType: string): ImportEntityType {
  if (!VALID_ENTITY_TYPES.includes(entityType as ImportEntityType)) {
    throw new NotFoundException(`Unknown import target "${entityType}" - expected one of ${VALID_ENTITY_TYPES.join(', ')}`);
  }
  return entityType as ImportEntityType;
}

// Excel/CSV/PDF Import (BRD section 17, 26 -> Import > Excel/CSV)
@Controller('import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN, RoleName.FINANCE)
export class ImportController {
  constructor(private readonly service: ImportService) {}

  @Get(':entityType/template')
  async template(@Param('entityType') entityTypeParam: string, @Res() res: Response) {
    const entityType = assertEntityType(entityTypeParam);
    const buffer = await this.service.generateTemplate(entityType);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${entityType.toLowerCase()}_import_template.xlsx"`);
    res.send(buffer);
  }

  @Post(':entityType/preview')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_FILE_SIZE_BYTES } }))
  async preview(@Param('entityType') entityTypeParam: string, @UploadedFile() file: Express.Multer.File) {
    const entityType = assertEntityType(entityTypeParam);
    if (!file) throw new BadRequestException('No file uploaded');

    const rows = await this.service.parseFile(file.buffer, file.originalname);
    return this.service.preview(entityType, rows);
  }

  @Post(':entityType/commit')
  async commit(@Param('entityType') entityTypeParam: string, @Body() dto: CommitImportDto, @CurrentUser() actor: AuthUser) {
    const entityType = assertEntityType(entityTypeParam);
    return this.service.commit(entityType, dto.rows, actor.userId, actor.roles);
  }
}
