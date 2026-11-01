import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuctionStatus } from '../auctions.types';

export class AuctionStatusQueryDto {
  @ApiPropertyOptional({ enum: AuctionStatus })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(AuctionStatus)
  status?: AuctionStatus;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @ApiPropertyOptional({ description: 'Opaque DynamoDB continuation cursor' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  cursor?: string;
}
