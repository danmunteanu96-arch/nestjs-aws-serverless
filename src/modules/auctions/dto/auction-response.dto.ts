import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuctionStatus } from '../auctions.types';

export class AuctionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ maxLength: 200 })
  title!: string;

  @ApiProperty({ enum: AuctionStatus })
  status!: AuctionStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  endDate?: string;

  @ApiProperty({ minimum: 0 })
  currentBid!: number;

  @ApiPropertyOptional()
  highestBidderId?: string;

  @ApiPropertyOptional({ description: 'Cognito sub of the auction creator' })
  createdBy?: string;
}
