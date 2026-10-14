import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AuctionStatus, CreateAuctionInput } from '../auctions.types';

export class CreateAuctionDto implements CreateAuctionInput {
  @ApiProperty({ maxLength: 200 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ enum: AuctionStatus })
  @IsEnum(AuctionStatus)
  status!: AuctionStatus;

  @ApiProperty({ format: 'date-time', example: '2026-10-20T10:00:00.000Z' })
  @Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  })
  @IsDateString({ strict: true })
  endDate!: string;
}
