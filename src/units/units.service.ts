import { Injectable, NotFoundException } from '@nestjs/common';
import { Unit } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit/audit.service';
import { assertUnused, deleteRecord } from '../common/delete.util';
import { StorageService } from '../common/storage/storage.service';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';

// The logo's storage key/type stay server-side - clients only learn hasLogo and
// fetch the image through GET /units/:id/logo.
function present(unit: Unit) {
  const { logoStorageKey, logoMimeType, ...rest } = unit;
  return { ...rest, hasLogo: !!logoStorageKey };
}

// '' (cleared input) means "no full name".
const blankToNull = (v: string | undefined) => (v === undefined ? undefined : v.trim() || null);

@Injectable()
export class UnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async findAll(activeOnly?: boolean) {
    const units = await this.prisma.unit.findMany({ where: activeOnly ? { isActive: true } : undefined, orderBy: { name: 'asc' } });
    return units.map(present);
  }

  private async findRaw(id: string) {
    const unit = await this.prisma.unit.findUnique({ where: { id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  async findOne(id: string) {
    return present(await this.findRaw(id));
  }

  async create(dto: CreateUnitDto, actorId: string) {
    const unit = present(await this.prisma.unit.create({ data: { ...dto, fullName: blankToNull(dto.fullName) } }));
    await this.audit.log({ userId: actorId, action: 'CREATE', objectType: 'Unit', objectId: unit.id, newValue: unit });
    return unit;
  }

  async update(id: string, dto: UpdateUnitDto, actorId: string) {
    const before = await this.findOne(id);
    const unit = present(await this.prisma.unit.update({ where: { id }, data: { ...dto, fullName: blankToNull(dto.fullName) } }));
    await this.audit.log({ userId: actorId, action: 'UPDATE', objectType: 'Unit', objectId: id, oldValue: before, newValue: unit });
    return unit;
  }

  async setLogo(id: string, file: Express.Multer.File, actorId: string) {
    const before = await this.findOne(id);
    const stored = await this.storage.save(file.buffer, `unit-logo/${id}`, file.originalname);
    const unit = present(await this.prisma.unit.update({ where: { id }, data: { logoStorageKey: stored.storageKey, logoMimeType: file.mimetype } }));
    await this.audit.log({ userId: actorId, action: 'UPLOAD_LOGO', objectType: 'Unit', objectId: id, oldValue: before, newValue: unit });
    return unit;
  }

  async removeLogo(id: string, actorId: string) {
    const before = await this.findOne(id);
    const unit = present(await this.prisma.unit.update({ where: { id }, data: { logoStorageKey: null, logoMimeType: null } }));
    await this.audit.log({ userId: actorId, action: 'REMOVE_LOGO', objectType: 'Unit', objectId: id, oldValue: before, newValue: unit });
    return unit;
  }

  async getLogo(id: string) {
    const unit = await this.findRaw(id);
    if (!unit.logoStorageKey) throw new NotFoundException('This unit has no logo');
    return { buffer: await this.storage.read(unit.logoStorageKey), mimeType: unit.logoMimeType ?? 'application/octet-stream' };
  }

  async remove(id: string, actorId: string) {
    const before = await this.findOne(id);
    // FK is ON DELETE SET NULL - the database would silently orphan these, so refuse instead.
    await assertUnused('Unit', [
      ['user(s)', this.prisma.user.count({ where: { unitId: id } })],
      ['expense participant(s)', this.prisma.expenseParticipant.count({ where: { unitId: id } })],
    ]);
    await deleteRecord('Unit', () => this.prisma.unit.delete({ where: { id } }));
    await this.audit.log({ userId: actorId, action: 'DELETE', objectType: 'Unit', objectId: id, oldValue: before });
    return { id };
  }
}
