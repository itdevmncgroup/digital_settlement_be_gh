import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { ActivityTypesService } from './activity-types.service';
import { CreateActivityTypeDto, UpdateActivityTypeDto } from './dto/activity-type.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('activity-types')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ActivityTypesController {
  constructor(private readonly service: ActivityTypesService) {}

  @Get()
  findAll(@Query('active') active?: string) {
    return this.service.findAll(active === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateActivityTypeDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateActivityTypeDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId);
  }
}
