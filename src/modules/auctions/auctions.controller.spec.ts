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
      .fn<(input: CreateAuctionDto, createdBy: string) => Promise<typeof auction>>()
      .mockResolvedValue(auction),
    getAll: jest
      .fn<(status?: AuctionStatus) => Promise<(typeof auction)[]>>()
      .mockResolvedValue([auction]),
    getActiveAuctions: jest
      .fn<() => Promise<(typeof auction)[]>>()
      .mockResolvedValue([auction]),
    getById: jest
      .fn<(id: string) => Promise<typeof auction>>()
      .mockResolvedValue(auction),
    update: jest
      .fn<(id: string, input: UpdateAuctionDto) => Promise<typeof auction>>()
      .mockResolvedValue(auction),
    placeBid: jest
      .fn<
        (id: string, input: PlaceBidDto, bidderId: string) => Promise<typeof auction>
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
    await expect(controller.getAll({})).resolves.toEqual([auction]);
    expect(auctionsService.getAll).toHaveBeenCalledWith(undefined);
  });

  it('passes a status filter to the service', async () => {
    await expect(
      controller.getAll({ status: AuctionStatus.CLOSED }),
    ).resolves.toEqual([auction]);
    expect(auctionsService.getAll).toHaveBeenCalledWith(AuctionStatus.CLOSED);
  });

  it('returns an auction by id from the service', async () => {
    await expect(controller.getById('auction-1')).resolves.toEqual(auction);
    expect(auctionsService.getById).toHaveBeenCalledWith('auction-1');
  });

  it('returns active auctions from the service', async () => {
    await expect(controller.getActiveAuctions()).resolves.toEqual([auction]);
    expect(auctionsService.getActiveAuctions).toHaveBeenCalled();
  });

  it('allows a partial update', async () => {
    await expect(
      controller.update('auction-1', { title: 'Updated camera' }),
    ).resolves.toEqual(auction);
    expect(auctionsService.update).toHaveBeenCalledWith('auction-1', {
      title: 'Updated camera',
    });
  });

  it('delegates bid placement to the service with the authenticated bidder', async () => {
    await expect(
      controller.placeBid('auction-1', { amount: 20 }, { sub: 'bidder-1' }),
    ).resolves.toEqual(auction);
    expect(auctionsService.placeBid).toHaveBeenCalledWith(
      'auction-1',
      { amount: 20 },
      'bidder-1',
    );
  });

  it('delegates valid auction data to the service with the authenticated creator', async () => {
    await expect(
      controller.create(
        {
          title: 'Vintage camera',
          status: 'ACTIVE',
          endDate: '2026-10-20T12:00:00+02:00',
        },
        { sub: 'user-1' },
      ),
    ).resolves.toEqual(auction);
    expect(auctionsService.create).toHaveBeenCalledWith(
      {
        title: 'Vintage camera',
        status: 'ACTIVE',
        endDate: '2026-10-20T12:00:00+02:00',
      },
      'user-1',
    );
  });
});
