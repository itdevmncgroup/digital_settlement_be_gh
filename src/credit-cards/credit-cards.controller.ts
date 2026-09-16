import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { CreditCardsService } from './credit-cards.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

@Controller('credit-cards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CreditCardsController {
  constructor(private readonly service: CreditCardsService) {}

  @Get()
  findAll(@Query('departmentId') departmentId?: string, @Query('active') active?: string) {
    return this.service.findAll(departmentId, active === 'true');
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @Roles(RoleName.ADMIN)
  create(@Body() dto: CreateCreditCardDto, @CurrentUser() actor: AuthUser) {
    return this.service.create(dto, actor.userId);
  }

  @Patch(':id')
  @Roles(RoleName.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateCreditCardDto, @CurrentUser() actor: AuthUser) {
    return this.service.update(id, dto, actor.userId);
  }
}
