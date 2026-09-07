import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { SalesAssignmentsService } from './sales-assignments.service';
import { CreateSalesAssignmentDto } from './dto/sales-assignment.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('sales-assignments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN)
export class SalesAssignmentsController {
  constructor(private readonly service: SalesAssignmentsService) {}

  @Get()
  findAll(@Query('salesId') salesId?: string) {
    return this.service.findAll(salesId);
  }

  @Post()
  create(@Body() dto: CreateSalesAssignmentDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }
}
