const SITE_FONTS = ['400 1em Unbounded', '500 1em Unbounded', '600 1em Unbounded', '700 1em Unbounded'];

export default function preloadFonts() {
  if ('fonts' in document) {
    return Promise.all(SITE_FONTS.map((font) => document.fonts.load(font)));
  }

  return undefined;
}
