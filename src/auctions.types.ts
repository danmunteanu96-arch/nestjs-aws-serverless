export type AuctionStatus = 'ACTIVE' | 'CLOSED';

export interface CreateAuctionInput {
  title: string;
  status: AuctionStatus;
  endDate: string;
}

export type UpdateAuctionInput = Partial<CreateAuctionInput>;

export interface PlaceBidInput {
  bidderId: string;
  amount: number;
}

export interface Auction extends Omit<CreateAuctionInput, 'endDate'> {
  id: string;
  createdAt: string;
  endDate?: string;
  currentBid: number;
  highestBidderId?: string;
}
