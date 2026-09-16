import { IsIn, IsString } from 'class-validator';

export class RegisterDeviceTokenDto {
  @IsString()
  token: string;

  @IsIn(['ANDROID', 'IOS'])
  platform: 'ANDROID' | 'IOS';
}
