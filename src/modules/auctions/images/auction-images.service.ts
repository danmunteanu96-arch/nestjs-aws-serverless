import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageOptimizerService } from './image-optimizer.service';

@Injectable()
export class AuctionImagesService {
  // One abort budget bounds connection, SDK retries, and response below Lambda deadlines.
  private static readonly OPERATION_TIMEOUT_MS = 5000;

  constructor(
    private readonly s3: S3Client,
    private readonly configService: ConfigService,
    private readonly optimizer: ImageOptimizerService,
  ) {}

  // Stores only optimized derivatives; original uploads and metadata never reach S3.
  async upload(
    auctionId: string,
    file: Express.Multer.File | undefined,
  ): Promise<string> {
    this.validate(file);
    const optimized = await this.optimizer.optimize(file.buffer);
    await Promise.all([
      this.putObject(this.keyFor(auctionId), optimized.image),
      this.putObject(this.thumbnailKeyFor(auctionId), optimized.thumbnail),
    ]);
    return this.keyFor(auctionId);
  }

  // S3 deletion is idempotent, and both derivatives are removed on every cleanup path.
  async removeByAuctionId(auctionId: string): Promise<void> {
    await Promise.all([
      this.deleteObject(this.keyFor(auctionId)),
      this.deleteObject(this.thumbnailKeyFor(auctionId)),
    ]);
  }

  // Signed response overrides lock both the rendered type and a safe inline filename.
  async createReadUrl(imageKey: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: imageKey,
        ResponseContentType: 'image/webp',
        ResponseContentDisposition: 'inline; filename="auction-image.webp"',
      }),
      { expiresIn: 300 },
    );
  }

  private keyFor(auctionId: string): string {
    return `auctions/${auctionId}/image.webp`;
  }

  private thumbnailKeyFor(auctionId: string): string {
    return `auctions/${auctionId}/thumbnail.webp`;
  }

  private async putObject(key: string, body: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        ContentLength: body.length,
        ServerSideEncryption: 'AES256',
      }),
      {
        abortSignal: AbortSignal.timeout(
          AuctionImagesService.OPERATION_TIMEOUT_MS,
        ),
      },
    );
  }

  private async deleteObject(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: key,
      }),
      {
        abortSignal: AbortSignal.timeout(
          AuctionImagesService.OPERATION_TIMEOUT_MS,
        ),
      },
    );
  }

  // Checks both the declared MIME type and magic bytes so renamed non-images are rejected.
  private validate(
    file: Express.Multer.File | undefined,
  ): asserts file is Express.Multer.File {
    if (!file || file.buffer.length === 0) {
      throw new BadRequestException('A non-empty auction image is required');
    }

    const bytes = file.buffer;
    const isJpeg =
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    const isPng =
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => bytes[index] === byte,
      );
    const isWebp =
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';

    const matchesDeclaredType =
      (file.mimetype === 'image/jpeg' && isJpeg) ||
      (file.mimetype === 'image/png' && isPng) ||
      (file.mimetype === 'image/webp' && isWebp);

    if (!matchesDeclaredType) {
      throw new BadRequestException(
        'Auction image must be a valid JPEG, PNG, or WebP file',
      );
    }
  }
}
