const SITE_FONTS = ['400 1em Onest', '500 1em Onest', '400 1em Unbounded'];

export default function preloadFonts() {
  if ('fonts' in document) {
    return Promise.all(SITE_FONTS.map((font) => document.fonts.load(font)));
  }

  return undefined;
}
