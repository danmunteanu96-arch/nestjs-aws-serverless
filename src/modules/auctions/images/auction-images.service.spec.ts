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
import { ImageOptimizerService } from './image-optimizer.service';

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
const optimized = {
  image: Buffer.from('optimized'),
  thumbnail: Buffer.from('thumbnail'),
};
const optimizer = () => ({
  optimize: jest
    .fn<(buffer: Buffer) => Promise<typeof optimized>>()
    .mockResolvedValue(optimized),
});
const config = () =>
  new ConfigService({ AUCTION_IMAGES_BUCKET: 'test-auction-images' });

describe('AuctionImagesService', () => {
  it('optimizes and uploads only two WebP derivatives', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const imageOptimizer = optimizer();
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      config(),
      imageOptimizer as unknown as ImageOptimizerService,
    );

    await expect(
      service.upload('auction-1', createFile('image/jpeg', jpeg)),
    ).resolves.toBe('auctions/auction-1/image.webp');

    const commands = send.mock.calls.map(
      ([command]) => command as PutObjectCommand,
    );
    expect(commands.map((command) => command.input.Key)).toEqual([
      'auctions/auction-1/image.webp',
      'auctions/auction-1/thumbnail.webp',
    ]);
    for (const command of commands) {
      expect(command.input.ContentType).toBe('image/webp');
      expect(command.input.ServerSideEncryption).toBe('AES256');
    }
    expect(imageOptimizer.optimize).toHaveBeenCalledWith(jpeg);
  });

  it.each([undefined, createFile('image/jpeg', Buffer.alloc(0))])(
    'rejects missing or empty images before optimization',
    async (file) => {
      const imageOptimizer = optimizer();
      const service = new AuctionImagesService(
        { send: jest.fn() } as unknown as S3Client,
        config(),
        imageOptimizer as unknown as ImageOptimizerService,
      );
      await expect(service.upload('auction-1', file)).rejects.toThrow(
        BadRequestException,
      );
      expect(imageOptimizer.optimize).not.toHaveBeenCalled();
    },
  );

  it('rejects spoofed MIME content before optimization', async () => {
    const imageOptimizer = optimizer();
    const service = new AuctionImagesService(
      { send: jest.fn() } as unknown as S3Client,
      config(),
      imageOptimizer as unknown as ImageOptimizerService,
    );
    await expect(
      service.upload(
        'auction-1',
        createFile('image/jpeg', Buffer.from('not a jpeg')),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(imageOptimizer.optimize).not.toHaveBeenCalled();
  });

  it('deletes both optimized objects for an auction', async () => {
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({});
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      config(),
      optimizer() as unknown as ImageOptimizerService,
    );

    await service.removeByAuctionId('auction-1');

    const commands = send.mock.calls.map(
      ([command]) => command as DeleteObjectCommand,
    );
    expect(commands.map((command) => command.input.Key)).toEqual([
      'auctions/auction-1/image.webp',
      'auctions/auction-1/thumbnail.webp',
    ]);
  });

  it('signs a five-minute inline WebP response without contacting S3', async () => {
    const service = new AuctionImagesService(
      new S3Client({
        region: 'eu-central-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }),
      config(),
      optimizer() as unknown as ImageOptimizerService,
    );

    const url = new URL(
      await service.createReadUrl('auctions/auction-1/image.webp'),
    );

    expect(url.pathname).toBe('/auctions/auction-1/image.webp');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-type')).toBe('image/webp');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="auction-image.webp"',
    );
  });

  it('bounds each S3 mutation with a five-second abort signal', async () => {
    const controller = new AbortController();
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((milliseconds) => {
        expect(milliseconds).toBe(5000);
        return controller.signal;
      });
    const send = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockImplementation(
        (_command, options) =>
          new Promise((_resolve, reject) => {
            (
              options as { abortSignal: AbortSignal }
            ).abortSignal.addEventListener(
              'abort',
              () => reject(new Error('S3 timed out')),
              { once: true },
            );
          }),
      );
    const service = new AuctionImagesService(
      { send } as unknown as S3Client,
      config(),
      optimizer() as unknown as ImageOptimizerService,
    );

    try {
      const rejection = expect(
        service.removeByAuctionId('auction-1'),
      ).rejects.toThrow('S3 timed out');
      controller.abort();
      await rejection;
    } finally {
      timeout.mockRestore();
    }
  });
});
