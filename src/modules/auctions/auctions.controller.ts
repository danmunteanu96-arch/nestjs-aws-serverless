import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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
  @ApiOperation({ summary: 'List auctions with bounded cursor pagination' })
  @ApiQuery({ name: 'status', enum: ['ACTIVE', 'CLOSED'], required: false })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/components/schemas/AuctionResponseDto' },
        },
        nextCursor: { type: 'string' },
      },
    },
  })
  getAll(@Query() query: AuctionStatusQueryDto): Promise<{
    items: AuctionResponseDto[];
    nextCursor?: string;
  }> {
    return this.auctionsService.getAll(query);
  }

  @Get('active')
  @ApiOperation({ summary: 'List active auctions by ending date' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/components/schemas/AuctionResponseDto' },
        },
        nextCursor: { type: 'string' },
      },
    },
  })
  getActiveAuctions(@Query() query: AuctionStatusQueryDto): Promise<{
    items: AuctionResponseDto[];
    nextCursor?: string;
  }> {
    return this.auctionsService.getActiveAuctions(query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: AuctionResponseDto })
  getById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.getById(id);
  }

  // Accepts auction fields and one bounded in-memory image in the same multipart request.
  @Post()
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'status', 'endDate', 'image'],
      properties: {
        title: { type: 'string', maxLength: 200 },
        status: { type: 'string', enum: ['ACTIVE'] },
        endDate: { type: 'string', format: 'date-time' },
        image: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiBearerAuth()
  @ApiCreatedResponse({ type: AuctionResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed or direct auction closure was requested',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  create(
    @Body() body: CreateAuctionDto,
    @UploadedFile() image: Express.Multer.File | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.create(body, image, user.sub);
  }

  @Patch(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBearerAuth()
  @ApiOkResponse({ type: AuctionResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed or direct auction closure was requested',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateAuctionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AuctionResponseDto> {
    return this.auctionsService.update(id, body, user.sub);
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
    return this.auctionsService.placeBid(id, body, user.sub, user.email);
  }
}
