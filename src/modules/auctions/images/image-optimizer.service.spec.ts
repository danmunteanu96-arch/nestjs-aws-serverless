import { describe, expect, it } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { ImageOptimizerService } from './image-optimizer.service';

// Real image fixtures exercise libvips decoding rather than trusting MIME declarations.
describe('ImageOptimizerService', () => {
  const optimizer = new ImageOptimizerService();

  it('creates bounded metadata-free WebP image and thumbnail', async () => {
    const input = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: '#336699' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const output = await optimizer.optimize(input);
    const image = await sharp(output.image).metadata();
    const thumbnail = await sharp(output.thumbnail).metadata();

    expect(image.format).toBe('webp');
    expect(image.width).toBe(800);
    expect(image.height).toBe(1600);
    expect(image.orientation).toBeUndefined();
    expect(image.exif).toBeUndefined();
    expect(thumbnail).toMatchObject({
      format: 'webp',
      width: 160,
      height: 320,
    });
    expect(output.image.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(output.thumbnail.length).toBeLessThanOrEqual(256 * 1024);
  });

  it('rejects corrupt content with a client-safe error', async () => {
    await expect(
      optimizer.optimize(Buffer.from('not an image')),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects images above forty megapixels before expensive resizing', async () => {
    const input = await sharp({
      create: { width: 8000, height: 5001, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();

    await expect(optimizer.optimize(input)).rejects.toThrow('40 megapixels');
  });
});
