import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { RoleName } from 'src/common/constants/role-name';
import { UnitsService } from './units.service';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// No SVG: served inline it could carry script.
const ALLOWED_LOGO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;

@Controller('units')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UnitsController {
  constructor(private readonly unitsService: UnitsService) {}

  @Get()
  findAll(@Query('active') active?: string) {
    return this.unitsService.findAll(active === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.unitsService.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateUnitDto, @CurrentUser() actor: AuthUser) {
    return this.unitsService.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateUnitDto, @CurrentUser() actor: AuthUser) {
    return this.unitsService.update(id, dto, actor.userId);
  }

  @Post(':id/logo')
  @Roles(RoleName.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_LOGO_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_LOGO_MIME_TYPES.includes(file.mimetype)) return cb(new Error('Logo must be a JPEG, PNG or WebP image'), false);
        cb(null, true);
      },
    }),
  )
  uploadLogo(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() actor: AuthUser) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.unitsService.setLogo(id, file, actor.userId);
  }

  @Delete(':id/logo')
  @Roles(RoleName.ADMIN)
  removeLogo(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.unitsService.removeLogo(id, actor.userId);
  }

  @Get(':id/logo')
  async logo(@Param('id') id: string, @Res() res: Response) {
    const logo = await this.unitsService.getLogo(id);
    res.setHeader('Content-Type', logo.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(logo.buffer);
  }

  @Delete(':id')
  @Roles(RoleName.ADMIN)
  remove(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    return this.unitsService.remove(id, actor.userId);
  }
}
