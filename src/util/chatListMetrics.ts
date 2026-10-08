import { CHAT_HEIGHT_PX } from '../config';

const BASE_ROOT_FONT_SIZE_PX = 16;

/**
 * Шаг строк списка чатов в пикселях. Строка чата задана в rem (`min-height: 4.5rem`), а список позиционирует
 * строки в px, поэтому при увеличенном шрифте (200% текста) шаг должен расти вместе с корневым размером шрифта,
 * иначе строки перекрываются (F-19).
 */
export function getChatHeightPx() {
  if (typeof document === 'undefined') return CHAT_HEIGHT_PX;

  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return rootFontSize > 0 ? Math.round(CHAT_HEIGHT_PX * rootFontSize / BASE_ROOT_FONT_SIZE_PX) : CHAT_HEIGHT_PX;
}
