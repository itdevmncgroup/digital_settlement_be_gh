import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { assertUnused, deleteRecord } from '../common/delete.util';
import { CreatePositionDto, UpdatePositionDto } from './dto/position.dto';

@Injectable()
export class PositionsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  findAll(activeOnly?: boolean) {
    return this.prisma.position.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
  }

  async findOne(id: string) {
    const position = await this.prisma.position.findUnique({ where: { id } });
    if (!position) throw new NotFoundException('Position not found');
    return position;
  }

  async create(dto: CreatePositionDto, actorId: string) {
    const position = await this.prisma.position.create({ data: dto });
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Position', objectId: position.id, newValue: position });
    return position;
  }

  async update(id: string, dto: UpdatePositionDto, actorId: string) {
    const before = await this.findOne(id);
    const position = await this.prisma.position.update({ where: { id }, data: dto });
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Position', objectId: id, oldValue: before, newValue: position });
    return position;
  }

  async remove(id: string, actorId: string) {
    const before = await this.findOne(id);
    // Cascade would silently drop it from a Level's requestor filter (making that Level match any requestor).
    const usedAsRequestor = await this.prisma.approvalLevelRequestorPosition.count({ where: { positionId: id } });
    if (usedAsRequestor > 0) {
      throw new ConflictException('Position is used as a requestor filter in an Approval Level. Remove it there first, or deactivate it instead.');
    }
    // FK is ON DELETE SET NULL - the database would silently orphan these, so refuse instead.
    await assertUnused('Position', [
      ['user(s)', this.prisma.user.count({ where: { positionId: id } })],
    ]);
    await deleteRecord('Position', () => this.prisma.position.delete({ where: { id } }));
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'Position', objectId: id, oldValue: before });
    return { id };
  }
}
