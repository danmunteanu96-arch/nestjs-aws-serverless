import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { AuctionsService } from './auctions.service';
import type { Auction } from './auctions.service';

@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @Get()
  getAll(): Promise<Auction[]> {
    return this.auctionsService.getAll();
  }

  @Get(':id')
  getById(@Param('id') id: string): Promise<Auction> {
    return this.auctionsService.getById(id);
  }

  @Post()
  create(@Body() body: unknown): Promise<Auction> {
    return this.auctionsService.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown): Promise<Auction> {
    return this.auctionsService.update(id, body);
  }

  @Post(':id/bids')
  placeBid(@Param('id') id: string, @Body() body: unknown): Promise<Auction> {
    return this.auctionsService.placeBid(id, body);
  }
}
