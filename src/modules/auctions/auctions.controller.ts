import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AuctionResponseDto } from './dto/auction-response.dto';
import { AuctionStatusQueryDto } from './dto/auction-status-query.dto';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { AuctionsService } from './auctions.service';

@ApiTags('auctions')
@Controller('auctions')
export class AuctionsController {
  constructor(private readonly auctionsService: AuctionsService) {}

  @Get()
  @ApiOperation({ summary: 'List auctions, optionally filtered by status' })
  @ApiQuery({ name: 'status', enum: ['ACTIVE', 'CLOSED'], required: false })
  @ApiOkResponse({ type: AuctionResponseDto, isArray: true })
  getAll(@Query() query: AuctionStatusQueryDto): Promise<AuctionResponseDto[]> {
    return this.auctionsService.getAll(query.status);
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
  @ApiBearerAuth()
  @ApiCreatedResponse({ type: AuctionResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  create(
    @Body() body: CreateAuctionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.create(body, user.sub);
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
  @ApiBearerAuth()
  @ApiCreatedResponse({ type: AuctionResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  placeBid(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PlaceBidDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.placeBid(id, body, user.sub);
  }
}
