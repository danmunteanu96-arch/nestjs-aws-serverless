import { BadRequestException } from '@nestjs/common';
import { AuctionsController } from './auctions.controller';
import { AuctionsService } from './auctions.service';

describe('AuctionsController', () => {
  const auction = {
    id: 'auction-1',
    title: 'Vintage camera',
    status: 'ACTIVE',
    createdAt: '2026-10-10T12:00:00.000Z',
  };
  const auctionsService = {
    create: jest.fn().mockResolvedValue(auction),
  };
  const controller = new AuctionsController(auctionsService as unknown as AuctionsService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates valid auction data to the service', async () => {
    await expect(
      controller.create({ title: 'Vintage camera', status: 'ACTIVE' }),
    ).resolves.toEqual(auction);
    expect(auctionsService.create).toHaveBeenCalledWith({
      title: 'Vintage camera',
      status: 'ACTIVE',
    });
  });

  it('requires title and status', async () => {
    await expect(controller.create({ title: '', status: 'ACTIVE' })).rejects.toThrow(
      BadRequestException,
    );
    expect(auctionsService.create).not.toHaveBeenCalled();
  });
});