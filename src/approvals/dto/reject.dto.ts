import { IsString, MinLength } from 'class-validator';

// BR-014: rejection wajib memiliki reason
export class RejectDto {
  @IsString()
  @MinLength(3)
  reason: string;
}
