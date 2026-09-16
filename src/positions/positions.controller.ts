import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { PositionsService } from './positions.service';
import { CreatePositionDto, UpdatePositionDto } from './dto/position.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('positions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  findAll(@Query('active') active?: string) {
    return this.positionsService.findAll(active === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.positionsService.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreatePositionDto, @CurrentUser() actor: AuthUser) {
    return this.positionsService.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdatePositionDto, @CurrentUser() actor: AuthUser) {
    return this.positionsService.update(id, dto, actor.userId);
  }
}
