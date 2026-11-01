import { z } from 'zod';

// Runtime validation keeps malformed queue payloads away from idempotency and SES.
export const winnerNotificationPayloadSchema = z
  .object({
    auctionId: z.string().min(1).max(128),
    recipient: z.string().email().max(320),
    title: z.string().min(1).max(200),
    winningBid: z.string().min(1).max(64).optional(),
  })
  .strict();

export type WinnerNotificationPayload = z.infer<
  typeof winnerNotificationPayloadSchema
>;

// Parsing is centralized so JSON syntax errors and schema errors share one boundary.
export function parseWinnerNotificationPayload(
  body: string,
): WinnerNotificationPayload {
  return winnerNotificationPayloadSchema.parse(JSON.parse(body));
}
