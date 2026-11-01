import { describe, expect, it, jest } from '@jest/globals';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';
import { AuctionStatus } from './auctions.types';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';

describe('AuctionsController', () => {
  const auction = {
    id: 'auction-1',
    title: 'Vintage camera',
    status: 'ACTIVE',
    endDate: '2026-10-20T10:00:00.000Z',
    createdAt: '2026-10-10T12:00:00.000Z',
  };
  const auctionsService = {
    create: jest
      .fn<
        (
          input: CreateAuctionDto,
          image: Express.Multer.File,
          createdBy: string,
        ) => Promise<typeof auction>
      >()
      .mockResolvedValue(auction),
    getAll: jest
      .fn<(query?: object) => Promise<{ items: (typeof auction)[] }>>()
      .mockResolvedValue({ items: [auction] }),
    getActiveAuctions: jest
      .fn<(query?: object) => Promise<{ items: (typeof auction)[] }>>()
      .mockResolvedValue({ items: [auction] }),
    getById: jest
      .fn<(id: string) => Promise<typeof auction>>()
      .mockResolvedValue(auction),
    update: jest
      .fn<
        (
          id: string,
          input: UpdateAuctionDto,
          ownerId: string,
        ) => Promise<typeof auction>
      >()
      .mockResolvedValue(auction),
    placeBid: jest
      .fn<
        (
          id: string,
          input: PlaceBidDto,
          bidderId: string,
          bidderEmail?: string,
        ) => Promise<typeof auction>
      >()
      .mockResolvedValue(auction),
  };
  const controller = new AuctionsController(
    auctionsService as unknown as AuctionsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all auctions from the service', async () => {
    await expect(controller.getAll({ limit: 50 })).resolves.toEqual({
      items: [auction],
    });
    expect(auctionsService.getAll).toHaveBeenCalledWith({ limit: 50 });
  });

  it('passes a status filter to the service', async () => {
    await expect(
      controller.getAll({ status: AuctionStatus.CLOSED, limit: 50 }),
    ).resolves.toEqual({ items: [auction] });
    expect(auctionsService.getAll).toHaveBeenCalledWith({
      status: AuctionStatus.CLOSED,
      limit: 50,
    });
  });

  it('returns an auction by id from the service', async () => {
    await expect(controller.getById('auction-1')).resolves.toEqual(auction);
    expect(auctionsService.getById).toHaveBeenCalledWith('auction-1');
  });

  it('returns active auctions from the service', async () => {
    await expect(controller.getActiveAuctions({ limit: 50 })).resolves.toEqual({
      items: [auction],
    });
    expect(auctionsService.getActiveAuctions).toHaveBeenCalledWith({
      limit: 50,
    });
  });

  it('allows a partial update by the authenticated owner', async () => {
    await expect(
      controller.update(
        'auction-1',
        { title: 'Updated camera' },
        { sub: 'owner-1' },
      ),
    ).resolves.toEqual(auction);
    expect(auctionsService.update).toHaveBeenCalledWith(
      'auction-1',
      {
        title: 'Updated camera',
      },
      'owner-1',
    );
  });

  it('delegates bid placement to the service with the authenticated bidder', async () => {
    await expect(
      controller.placeBid(
        'auction-1',
        { amount: 20 },
        { sub: 'bidder-1', email: 'winner@example.com' },
      ),
    ).resolves.toEqual(auction);
    expect(auctionsService.placeBid).toHaveBeenCalledWith(
      'auction-1',
      { amount: 20 },
      'bidder-1',
      'winner@example.com',
    );
  });

  it('delegates valid auction data and its image with the authenticated creator', async () => {
    const image = {
      originalname: 'camera.jpg',
      buffer: Buffer.from('image'),
    } as Express.Multer.File;
    // Match the DTO's enum type so this fixture tests delegation, not TypeScript coercion.
    const input = {
      title: 'Vintage camera',
      status: AuctionStatus.ACTIVE,
      endDate: '2026-10-20T12:00:00+02:00',
    };

    await expect(
      controller.create(input, image, { sub: 'user-1' }),
    ).resolves.toEqual(auction);
    expect(auctionsService.create).toHaveBeenCalledWith(input, image, 'user-1');
  });
});
