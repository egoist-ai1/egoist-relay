import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Api as GramJs } from '../../../lib/gramjs';

import { buildStickerFromDocument } from './symbols';

vi.mock('../../../util/browser/windowEnvironment', () => ({ IS_TOUCH_ENV: false, IS_IOS: false }));

let getStickerDimensions: typeof import('../../../components/common/helpers/mediaDimensions').getStickerDimensions;

beforeAll(async () => {
  document.documentElement.style.fontSize = '16px';
  ({ getStickerDimensions } = await import('../../../components/common/helpers/mediaDimensions'));
});

function makeStickerDocument(
  mediaSize?: { w: number; h: number },
  thumbSize?: { w: number; h: number },
) {
  const document = new GramJs.Document({
    id: BigInt(101),
    accessHash: BigInt(1),
    fileReference: new Uint8Array(),
    date: 0,
    mimeType: 'image/webp',
    size: BigInt(1),
    dcId: 1,
    attributes: [
      new GramJs.DocumentAttributeSticker({
        alt: '🙂',
        stickerset: new GramJs.InputStickerSetEmpty(),
      }),
      ...(mediaSize ? [new GramJs.DocumentAttributeImageSize(mediaSize)] : []),
    ],
    thumbs: thumbSize ? [new GramJs.PhotoCachedSize({
      type: 'm', ...thumbSize, bytes: new Uint8Array(),
    })] : undefined,
  });
  return document;
}

describe('sticker dimensions', () => {
  test('uses the actual media dimensions when its cached thumbnail is unusually narrow', () => {
    const sticker = buildStickerFromDocument(makeStickerDocument(
      { w: 512, h: 512 }, { w: 48, h: 512 },
    ));
    expect(sticker).toMatchObject({ width: 512, height: 512 });
  });

  test('uses valid thumbnail dimensions when the document does not provide media dimensions', () => {
    const sticker = buildStickerFromDocument(makeStickerDocument(undefined, { w: 128, h: 256 }));
    expect(sticker).toMatchObject({ width: 128, height: 256 });
  });

  test('ignores invalid dimensions instead of generating a negative layout', () => {
    const sticker = buildStickerFromDocument(makeStickerDocument(
      { w: -512, h: 512 }, { w: 0, h: 128 },
    ));
    expect(sticker).toMatchObject({ width: undefined, height: undefined });
    const dimensions = getStickerDimensions(sticker!);
    expect(dimensions.width).toBe(dimensions.height);
  });

  test('keeps portrait and landscape stickers within the same display bound', () => {
    const portrait = getStickerDimensions(buildStickerFromDocument(makeStickerDocument({ w: 128, h: 512 }))!);
    const landscape = getStickerDimensions(buildStickerFromDocument(makeStickerDocument({ w: 512, h: 128 }))!);
    expect(portrait.width).toBeLessThan(portrait.height);
    expect(landscape.width).toBeGreaterThan(landscape.height);
    expect(portrait.height).toBe(landscape.width);
  });
});
