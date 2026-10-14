import { describe, expect, it } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuctionStatus } from '../auctions.types';
import { CreateAuctionDto } from './create-auction.dto';
import { PlaceBidDto } from './place-bid.dto';
import { UpdateAuctionDto } from './update-auction.dto';
import { AuctionStatusQueryDto } from './auction-status-query.dto';

describe('auction DTOs', () => {
  it('accepts valid create input and trims the title', async () => {
    const dto = plainToInstance(CreateAuctionDto, {
      title: ' Camera ',
      status: AuctionStatus.ACTIVE,
      endDate: '2026-10-20T12:00:00+02:00',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.title).toBe('Camera');
    expect(dto.endDate).toBe('2026-10-20T10:00:00.000Z');
  });

  it('rejects invalid statuses and malformed end dates', async () => {
    const dto = plainToInstance(CreateAuctionDto, {
      title: 'Camera',
      status: 'PAUSED',
      endDate: 'next week',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['status', 'endDate']),
    );
  });

  it('rejects non-positive bid amounts', async () => {
    const dto = plainToInstance(PlaceBidDto, {
      bidderId: 'bidder-1',
      amount: 0,
    });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      'amount',
    );
  });

  it('allows partial updates', async () => {
    const dto = plainToInstance(UpdateAuctionDto, { title: 'Updated camera' });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('normalizes and validates a lowercase status query', async () => {
    const dto = plainToInstance(AuctionStatusQueryDto, { status: 'active' });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.status).toBe(AuctionStatus.ACTIVE);
  });
});
