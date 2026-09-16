import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { AdvertisersService } from './advertisers.service';
import { CreateAdvertiserDto, UpdateAdvertiserDto } from './dto/advertiser.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// Master Advertiser (BRD section 5.4, 26 -> Master > Advertiser; formerly "Client")
@Controller('advertisers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdvertisersController {
  constructor(private readonly service: AdvertisersService) {}

  @Get()
  findAll(@Query('search') search?: string, @Query('agencyId') agencyId?: string, @Query('active') active?: string) {
    return this.service.findAll({ search, agencyId, activeOnly: active === 'true' });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateAdvertiserDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateAdvertiserDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId);
  }
}
