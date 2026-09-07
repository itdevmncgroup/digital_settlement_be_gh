import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { RoleName } from 'src/common/constants/role-name';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AssignRolesDto } from './dto/assign-roles.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

// System Administrator: manage user (BRD section 5.4, 26 -> System > User)
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleName.ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Read access also open to Finance - needed to pick a Sales when creating an
  // Expense on their behalf (BRD section 5.3).
  @Get()
  @Roles(RoleName.ADMIN, RoleName.FINANCE)
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @Roles(RoleName.ADMIN, RoleName.FINANCE)
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.create(dto, actor.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.update(id, dto, actor.userId);
  }

  @Patch(':id/roles')
  assignRoles(@Param('id') id: string, @Body() dto: AssignRolesDto, @CurrentUser() actor: AuthUser) {
    return this.usersService.assignRoles(id, dto.roles, actor.userId);
  }
}
