import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { BrandsService } from './brands.service';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Master Brand (BRD section 5.4, 26 -> Master > Brand)
@Controller('brands')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BrandsController {
  constructor(private readonly service: BrandsService) {}

  @Get()
  findAll(@Query('search') search?: string, @Query('advertiserIds') advertiserIds?: string, @Query('active') active?: string) {
    return this.service.findAll({
      search,
      advertiserIds: advertiserIds ? advertiserIds.split(',').filter(Boolean) : undefined,
      activeOnly: active === 'true',
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateBrandDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateBrandDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId);
  }
}
