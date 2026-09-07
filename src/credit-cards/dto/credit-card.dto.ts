import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CreateCreditCardDto {
  @IsString()
  bank: string;

  @IsString()
  @Length(4, 4)
  last4: string;

  @IsString()
  cardHolderName: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // 1 POD = 1 credit card - a Sales in this POD may only spend on this card.
  @IsOptional()
  @IsString()
  podId?: string;
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
  @IsString()
  cardHolderName?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  podId?: string;
}
