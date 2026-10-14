import { Transform } from 'class-transformer';
import { IsEnum, IsOptional } from 'class-validator';
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
}
