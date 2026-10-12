export type AuctionStatus = 'ACTIVE' | 'CLOSED';

export interface CreateAuctionInput {
  title: string;
  status: AuctionStatus;
}

export type UpdateAuctionInput = Partial<CreateAuctionInput>;

export interface PlaceBidInput {
  bidderId: string;
  amount: number;
}

export interface Auction extends CreateAuctionInput {
  id: string;
  createdAt: string;
  currentBid: number;
  highestBidderId?: string;
}
