import { IsArray, ArrayNotEmpty } from 'class-validator';

export class CommitImportDto {
  @IsArray()
  @ArrayNotEmpty()
  rows: Record<string, string>[];
}
