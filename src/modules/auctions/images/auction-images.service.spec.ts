import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { AuctionImagesService } from './auction-images.service';

const createFile = (mimetype: string, buffer: Buffer): Express.Multer.File => ({
  fieldname: 'image',
  originalname: 'product-image',
  encoding: '7bit',
  mimetype,
  size: buffer.length,
  buffer,
  destination: '',
  filename: '',
  path: '',
  stream: Readable.from(buffer),
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const webp = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe('AuctionImagesService', () => {
  it.each([
    ['image/jpeg', jpeg],
    ['image/png', png],
    ['image/webp', webp],
  ])(
    'uploads a valid %s under the auction-owned key',
    async (mimetype, buffer) => {
      const send = jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({});
      const service = new AuctionImagesService(
        { send } as unknown as S3Client,
        new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
      );

      await expect(
        service.upload('auction-1', createFile(mimetype, buffer)),
      ).resolves.toBe('auctions/auction-1/image');

      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'test-auction-images',
        Key: 'auctions/auction-1/image',
        Body: buffer,
        ContentType: mimetype,
        ContentLength: buffer.length,
        ServerSideEncryption: 'AES256',
      });
    },
  );

  it('rejects a missing image before calling S3', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    await expect(service.upload('auction-1', undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an empty image before calling S3', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    await expect(
      service.upload('auction-1', createFile('image/jpeg', Buffer.alloc(0))),
    ).rejects.toThrow(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a MIME type outside the allowed image formats', async () => {
    const service = new AuctionImagesService(
      { send: jest.fn() } as unknown as S3Client,
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    await expect(
      service.upload('auction-1', createFile('image/gif', jpeg)),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects spoofed MIME content before calling S3', async () => {
    const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    await expect(
      service.upload(
        'auction-1',
        createFile('image/jpeg', Buffer.from('not a jpeg')),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes only the deterministic image object for an auction', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    await service.removeByAuctionId('auction-1');

    const command = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'test-auction-images',
      Key: 'auctions/auction-1/image',
    });
  });

  // Drive each abort signal manually to verify the five-second budget for both S3 mutations.
  it.each([
    {
      operation: 'upload',
      error: 'S3 upload timed out',
      run: (service: AuctionImagesService) =>
        service.upload('auction-1', createFile('image/jpeg', jpeg)),
    },
    {
      operation: 'deletion',
      error: 'S3 deletion timed out',
      run: (service: AuctionImagesService) =>
        service.removeByAuctionId('auction-1'),
    },
  ])(
    'aborts a hung image $operation after five seconds',
    async ({ error, run }) => {
      const controller = new AbortController();
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((milliseconds) => {
          expect(milliseconds).toBe(5000);
          return controller.signal;
        });
      const send = jest
        .fn<
          (
            command: PutObjectCommand | DeleteObjectCommand,
            options: { abortSignal: AbortSignal },
          ) => Promise<unknown>
        >()
        .mockImplementation(
          (_command, { abortSignal }) =>
            new Promise((_resolve, reject) => {
              abortSignal.addEventListener(
                'abort',
                () => reject(new Error(error)),
                {
                  once: true,
                },
              );
            }),
        );
      const service = new AuctionImagesService(
        { send } as unknown as S3Client,
        new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
      );

      try {
        const rejection = expect(run(service)).rejects.toThrow(error);
        controller.abort();
        await rejection;
        expect(timeout).toHaveBeenCalledWith(5000);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it('creates a signed five-minute read URL without contacting S3', async () => {
    const service = new AuctionImagesService(
      new S3Client({
        region: 'eu-central-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
      new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' }),
    );

    const url = new URL(
      await service.createReadUrl('auctions/auction-1/image'),
    );

    expect(url.hostname).toBe(
      'test-auction-images.s3.eu-central-1.amazonaws.com',
    );
    expect(url.pathname).toBe('/auctions/auction-1/image');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
