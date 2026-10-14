import { BadRequestException } from '@nestjs/common';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';

describe('AuctionsController', () => {
  const auction = {
    id: 'auction-1',
    title: 'Vintage camera',
    status: 'ACTIVE',
    endDate: '2026-10-20T10:00:00.000Z',
    createdAt: '2026-10-10T12:00:00.000Z',
  };
  const auctionsService = {
    create: jest.fn().mockResolvedValue(auction),
    getAll: jest.fn().mockResolvedValue([auction]),
    getActiveAuctions: jest.fn().mockResolvedValue([auction]),
    getById: jest.fn().mockResolvedValue(auction),
    update: jest.fn().mockResolvedValue(auction),
    placeBid: jest.fn().mockResolvedValue(auction),
  };
  const controller = new AuctionsController(
    auctionsService as unknown as AuctionsService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns all auctions from the service', async () => {
    await expect(controller.getAll()).resolves.toEqual([auction]);
    expect(auctionsService.getAll).toHaveBeenCalled();
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

  it('delegates bid placement to the service', async () => {
    await expect(
      controller.placeBid('auction-1', { bidderId: 'bidder-1', amount: 20 }),
    ).resolves.toEqual(auction);
    expect(auctionsService.placeBid).toHaveBeenCalledWith('auction-1', {
      bidderId: 'bidder-1',
      amount: 20,
    });
  });

  it('rejects an empty patch body', async () => {
    await expect(controller.update('auction-1', {})).rejects.toThrow(
      BadRequestException,
    );
    expect(auctionsService.update).not.toHaveBeenCalled();
  });

  it('delegates valid auction data to the service', async () => {
    await expect(
      controller.create({
        title: 'Vintage camera',
        status: 'ACTIVE',
        endDate: '2026-10-20T12:00:00+02:00',
      }),
    ).resolves.toEqual(auction);
    expect(auctionsService.create).toHaveBeenCalledWith({
      title: 'Vintage camera',
      status: 'ACTIVE',
      endDate: '2026-10-20T10:00:00.000Z',
    });
  });

  it('requires title and status', async () => {
    await expect(
      controller.create({ title: '', status: 'ACTIVE' }),
    ).rejects.toThrow(BadRequestException);
    expect(auctionsService.create).not.toHaveBeenCalled();
  });
});
