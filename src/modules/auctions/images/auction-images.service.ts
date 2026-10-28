import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuctionImagesService {
  // One abort budget bounds connection, SDK retries, and response below Lambda deadlines.
  private static readonly OPERATION_TIMEOUT_MS = 5000;

  constructor(
    private readonly s3: S3Client,
    private readonly configService: ConfigService,
  ) {}

  // Validates and uploads one product image, returning only its server-owned S3 key.
  async upload(
    auctionId: string,
    file: Express.Multer.File | undefined,
  ): Promise<string> {
    this.validate(file);
    const key = this.keyFor(auctionId);

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        ContentLength: file.buffer.length,
        ServerSideEncryption: 'AES256',
      }),
      {
        abortSignal: AbortSignal.timeout(
          AuctionImagesService.OPERATION_TIMEOUT_MS,
        ),
      },
    );

    return key;
  }

  // Deletes the deterministic object; S3 treats an absent key as success, making retries safe.
  async removeByAuctionId(auctionId: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: this.keyFor(auctionId),
      }),
      {
        abortSignal: AbortSignal.timeout(
          AuctionImagesService.OPERATION_TIMEOUT_MS,
        ),
      },
    );
  }

  // Signs a temporary local URL so a private S3 object can be read without public access.
  async createReadUrl(imageKey: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.configService.getOrThrow<string>('AUCTION_IMAGES_BUCKET'),
        Key: imageKey,
      }),
      { expiresIn: 300 },
    );
  }

  // Builds keys without user-controlled filenames, preventing path injection and collisions.
  private keyFor(auctionId: string): string {
    return `auctions/${auctionId}/image`;
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
