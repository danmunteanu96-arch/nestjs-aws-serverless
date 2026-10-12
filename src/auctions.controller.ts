import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuctionsService } from './auctions.service';
import type { Auction, CreateAuctionInput } from './auctions.service';

@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @Post()
  create(@Body() body: CreateAuctionInput): Promise<Auction> {
    if (!body?.title || !body?.status) {
      throw new BadRequestException('title and status are required');
    }

    return this.auctionsService.create(body);
  }
}
