import { BadRequestException, Injectable } from '@nestjs/common';
import sharp from 'sharp';

export interface OptimizedImages {
  image: Buffer;
  thumbnail: Buffer;
}

@Injectable()
export class ImageOptimizerService {
  private static readonly MAX_PIXELS = 40_000_000;

  // Sharp strips metadata by default; rotate applies EXIF before bounded WebP conversion.
  async optimize(buffer: Buffer): Promise<OptimizedImages> {
    try {
      const source = sharp(buffer, {
        limitInputPixels: ImageOptimizerService.MAX_PIXELS,
      });
      const metadata = await source.metadata();
      const pixels = (metadata.width ?? 0) * (metadata.height ?? 0);
      if (pixels > ImageOptimizerService.MAX_PIXELS) {
        throw new BadRequestException(
          'Auction image cannot exceed 40 megapixels',
        );
      }

      const [image, thumbnail] = await Promise.all([
        source
          .clone()
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toBuffer(),
        source
          .clone()
          .rotate()
          .resize({
            width: 320,
            height: 320,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 75 })
          .toBuffer(),
      ]);
      if (image.length > 2 * 1024 * 1024 || thumbnail.length > 256 * 1024) {
        throw new BadRequestException('Optimized auction image is too large');
      }
      return { image, thumbnail };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof Error && error.message.includes('pixel limit')) {
        throw new BadRequestException(
          'Auction image cannot exceed 40 megapixels',
          { cause: error },
        );
      }
      throw new BadRequestException(
        'Auction image could not be decoded safely',
        { cause: error },
      );
    }
  }
}
