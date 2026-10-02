export type NativeAppBounds = { x: number; y: number; width: number; height: number };

export function resolveAppBounds(
  rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>,
  viewport: { width: number; height: number },
  nativeViewport: { width: number; height: number },
): NativeAppBounds {
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height,
    nativeViewport.width, nativeViewport.height].every(Number.isFinite)
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || viewport.width <= 0 || viewport.height <= 0 || nativeViewport.width <= 0 || nativeViewport.height <= 0) {
    throw new Error('Relay viewport is unavailable');
  }
  const scaleX = nativeViewport.width / viewport.width;
  const scaleY = nativeViewport.height / viewport.height;
  const x = Math.round(rect.x * scaleX);
  const y = Math.round(rect.y * scaleY);
  const right = Math.min(nativeViewport.width, Math.round((rect.x + rect.width) * scaleX));
  const bottom = Math.min(nativeViewport.height, Math.round((rect.y + rect.height) * scaleY));
  if (right <= x || bottom <= y) throw new Error('Relay viewport is outside the native window');
  return { x, y, width: right - x, height: bottom - y };
}
