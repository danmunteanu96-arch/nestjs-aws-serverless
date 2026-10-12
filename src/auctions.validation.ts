import { BadRequestException } from '@nestjs/common';
import type {
  CreateAuctionInput,
  PlaceBidInput,
  UpdateAuctionInput,
} from './auctions.types';

const allowedStatuses = new Set(['ACTIVE', 'CLOSED']);
const allowedAuctionFields = new Set(['title', 'status']);

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowedFields: Set<string>,
): void {
  const unexpectedField = Object.keys(value).find(
    (field) => !allowedFields.has(field),
  );
  if (unexpectedField) {
    throw new BadRequestException(`Unexpected field: ${unexpectedField}`);
  }
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new BadRequestException(
      'title must be a non-empty string of at most 200 characters',
    );
  }

  return value.trim();
}

function parseStatus(value: unknown): CreateAuctionInput['status'] {
  if (typeof value !== 'string' || !allowedStatuses.has(value)) {
    throw new BadRequestException('status must be ACTIVE or CLOSED');
  }

  return value as CreateAuctionInput['status'];
}

export function parseAuctionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
    throw new BadRequestException(
      'id must be a non-empty string of at most 128 characters',
    );
  }

  return value.trim();
}

export function parseCreateAuctionInput(value: unknown): CreateAuctionInput {
  const input = asObject(value, 'Auction');
  assertOnlyFields(input, allowedAuctionFields);

  return {
    title: parseTitle(input.title),
    status: parseStatus(input.status),
  };
}

export function parseUpdateAuctionInput(value: unknown): UpdateAuctionInput {
  const input = asObject(value, 'Update');
  assertOnlyFields(input, allowedAuctionFields);

  if (Object.keys(input).length === 0) {
    throw new BadRequestException('Provide title and/or status to update');
  }

  const update: UpdateAuctionInput = {};
  if (Object.hasOwn(input, 'title')) {
    update.title = parseTitle(input.title);
  }
  if (Object.hasOwn(input, 'status')) {
    update.status = parseStatus(input.status);
  }

  return update;
}

export function parsePlaceBidInput(value: unknown): PlaceBidInput {
  const input = asObject(value, 'Bid');
  assertOnlyFields(input, new Set(['bidderId', 'amount']));

  if (
    typeof input.bidderId !== 'string' ||
    !input.bidderId.trim() ||
    input.bidderId.trim().length > 128
  ) {
    throw new BadRequestException(
      'bidderId must be a non-empty string of at most 128 characters',
    );
  }
  if (
    typeof input.amount !== 'number' ||
    !Number.isFinite(input.amount) ||
    input.amount <= 0
  ) {
    throw new BadRequestException('amount must be a positive finite number');
  }

  return { bidderId: input.bidderId.trim(), amount: input.amount };
}
