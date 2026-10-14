export const AuctionStatus = {
  ACTIVE: 'ACTIVE',
  CLOSED: 'CLOSED',
} as const;

export type AuctionStatus = (typeof AuctionStatus)[keyof typeof AuctionStatus];

export interface CreateAuctionInput {
  title: string;
  status: AuctionStatus;
  endDate: string;
}

export interface Auction extends Omit<CreateAuctionInput, 'endDate'> {
  id: string;
  createdAt: string;
  endDate?: string;
  currentBid: number;
  highestBidderId?: string;
}
