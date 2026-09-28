import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CreateCreditCardDto {
  @IsString()
  bank: string;

  @IsString()
  @Length(4, 4)
  last4: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // 1 Department / 1 User(Position) can each hold more than one card.
  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}

export class UpdateCreditCardDto {
  @IsOptional()
  @IsString()
  bank?: string;

  @IsOptional()
  @IsString()
  @Length(4, 4)
  last4?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsString()
  userId?: string;
}
