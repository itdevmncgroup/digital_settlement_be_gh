import { IsString, MinLength } from 'class-validator';

// A revise always requires a reason, same rule as reject (BR-014).
export class ReviseDto {
  @IsString()
  @MinLength(3)
  reason: string;
}
