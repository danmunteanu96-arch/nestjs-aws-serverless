import { BadRequestException } from '@nestjs/common';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';

const keySchema = z
  .object({
    id: z.object({ S: z.string().min(1) }).strict(),
    status: z
      .object({ S: z.string().min(1) })
      .strict()
      .optional(),
    endDate: z
      .object({ S: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const cursorSchema = z.object({ filter: z.string(), key: keySchema }).strict();

// Cursors contain only DynamoDB keys, never filters or record data supplied by clients.
export function encodeAuctionCursor(
  filter: string | undefined,
  key: Record<string, AttributeValue>,
): string {
  return Buffer.from(JSON.stringify({ filter: filter ?? 'ALL', key })).toString(
    'base64url',
  );
}

export function decodeAuctionCursor(
  cursor: string,
  filter: string | undefined,
): Record<string, AttributeValue> {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.filter !== (filter ?? 'ALL'))
      throw new Error('Cursor filter mismatch');
    return parsed.key;
  } catch (error) {
    throw new BadRequestException('Invalid or expired auction cursor', {
      cause: error,
    });
  }
}
