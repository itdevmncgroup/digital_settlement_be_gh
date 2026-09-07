import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './common/audit/audit.module';
import { StorageModule } from './common/storage/storage.module';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';

import { UnitsModule } from './units/units.module';
import { DepartmentsModule } from './departments/departments.module';
import { PositionsModule } from './positions/positions.module';
import { AgenciesModule } from './agencies/agencies.module';
import { AdvertisersModule } from './advertisers/advertisers.module';
import { BrandsModule } from './brands/brands.module';
import { PodsModule } from './pods/pods.module';
import { SalesAssignmentsModule } from './sales-assignments/sales-assignments.module';
import { ActivityTypesModule } from './activity-types/activity-types.module';
import { CostCentersModule } from './cost-centers/cost-centers.module';
import { ExpenseCategoriesModule } from './expense-categories/expense-categories.module';
import { MerchantsModule } from './merchants/merchants.module';
import { CreditCardsModule } from './credit-cards/credit-cards.module';

import { EventsModule } from './events/events.module';
import { ExpensesModule } from './expenses/expenses.module';
import { InvoicesModule } from './invoices/invoices.module';
import { ApprovalsModule } from './approvals/approvals.module';

import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ImportModule } from './import/import.module';
import { BankMatchingModule } from './bank-matching/bank-matching.module';
import { SettlementsModule } from './settlements/settlements.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        ttl: (Number(process.env.THROTTLE_TTL) || 60) * 1000,
        limit: Number(process.env.THROTTLE_LIMIT) || 100,
      },
    ]),

    PrismaModule,
    AuditModule,
    StorageModule,

    AuthModule,
    UsersModule,
    RolesModule,

    UnitsModule,
    DepartmentsModule,
    PositionsModule,
    AgenciesModule,
    AdvertisersModule,
    BrandsModule,
    PodsModule,
    SalesAssignmentsModule,
    ActivityTypesModule,
    CostCentersModule,
    ExpenseCategoriesModule,
    MerchantsModule,
    CreditCardsModule,

    EventsModule,
    ExpensesModule,
    InvoicesModule,
    ApprovalsModule,

    AuditLogsModule,
    DashboardModule,
    ImportModule,
    BankMatchingModule,
    SettlementsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
