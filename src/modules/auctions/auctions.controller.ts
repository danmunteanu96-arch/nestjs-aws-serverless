import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AuctionResponseDto } from './dto/auction-response.dto';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { AuctionsService } from './auctions.service';

@ApiTags('auctions')
@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @Get()
  @ApiOperation({ summary: 'List auctions' })
  @ApiOkResponse({ type: AuctionResponseDto, isArray: true })
  getAll(): Promise<AuctionResponseDto[]> {
    return this.auctionsService.getAll();
  }

  @Get('active')
  @ApiOperation({ summary: 'List active auctions by ending date' })
  @ApiOkResponse({ type: AuctionResponseDto, isArray: true })
  getActiveAuctions(): Promise<AuctionResponseDto[]> {
    return this.auctionsService.getActiveAuctions();
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuctionResponseDto })
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.getById(id);
  }

  @Post()
  @ApiCreatedResponse({ type: AuctionResponseDto })
  create(@Body() body: CreateAuctionDto): Promise<AuctionResponseDto> {
    return this.auctionsService.create(body);
  }

  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuctionResponseDto })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAuctionDto,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.update(id, body);
  }

  @Post(':id/bids')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: AuctionResponseDto })
  placeBid(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PlaceBidDto,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.placeBid(id, body);
  }
}
