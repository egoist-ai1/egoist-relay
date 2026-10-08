import { CHAT_HEIGHT_PX, PEER_PICKER_ITEM_HEIGHT_PX } from '../config';

const BASE_ROOT_FONT_SIZE_PX = 16;

/**
 * Шаг строк списка чатов в пикселях. Строка чата задана в rem (`min-height: 4.5rem`), а список позиционирует
 * строки в px, поэтому при увеличенном шрифте (200% текста) шаг должен расти вместе с корневым размером шрифта,
 * иначе строки перекрываются (F-19).
 */
export function getChatHeightPx() {
  return scaleToRootFontSize(CHAT_HEIGHT_PX);
}

/** Шаг строк в списках получателей (пикеры): строка задана в rem, позиция — в px. */
export function getPeerPickerItemHeightPx() {
  return scaleToRootFontSize(PEER_PICKER_ITEM_HEIGHT_PX);
}

function scaleToRootFontSize(basePx: number) {
  if (typeof document === 'undefined') return basePx;

  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return rootFontSize > 0 ? Math.round(basePx * rootFontSize / BASE_ROOT_FONT_SIZE_PX) : basePx;
}
