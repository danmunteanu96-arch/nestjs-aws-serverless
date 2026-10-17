import { Type } from 'class-transformer';
import { IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PlaceBidDto {
  @ApiProperty({ minimum: 0, exclusiveMinimum: true })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
  amount!: number;
}
