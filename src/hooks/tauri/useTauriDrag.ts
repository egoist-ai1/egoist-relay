import { useCallback, useEffect } from '../../lib/teact/teact';

import { forceMutation } from '../../lib/fasterdom/stricterdom';
import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';
import { getTauriWindowSync } from '../../util/tauri/initTauriApi';

const NO_DRAG_ELEMENTS = [
  'input', 'a', 'button', 'textarea', 'select', '[contenteditable="true"]', '.ListItem-button',
  '.chat-item-clickable', '.Button', '[role="button"]', '.Avatar', '.Avatar-wrapper', '.ChatInfo .info',
  '.HeaderActions',
].join(', ');
const RESIZE_BORDER_WIDTH = 6;

type ResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West';

function getResizeDirection(x: number, y: number): { direction: ResizeDirection; cursor: string } | undefined {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const onLeft = x <= RESIZE_BORDER_WIDTH;
  const onRight = x >= w - RESIZE_BORDER_WIDTH;
  const onTop = y <= RESIZE_BORDER_WIDTH;
  const onBottom = y >= h - RESIZE_BORDER_WIDTH;

  if (onTop && onLeft) return { direction: 'NorthWest', cursor: 'nwse-resize' };
  if (onTop && onRight) return { direction: 'NorthEast', cursor: 'nesw-resize' };
  if (onBottom && onLeft) return { direction: 'SouthWest', cursor: 'nesw-resize' };
  if (onBottom && onRight) return { direction: 'SouthEast', cursor: 'nwse-resize' };
  if (onTop) return { direction: 'North', cursor: 'ns-resize' };
  if (onBottom) return { direction: 'South', cursor: 'ns-resize' };
  if (onLeft) return { direction: 'West', cursor: 'ew-resize' };
  if (onRight) return { direction: 'East', cursor: 'ew-resize' };

  return undefined;
}

function updateResizeCursor(cursor: string) {
  const body = document.body;
  const currentCursor = body.style.cursor;
  if (currentCursor === cursor || (!cursor && !currentCursor.includes('resize'))) return;

  forceMutation(() => {
    body.style.cursor = cursor;
  }, body, true);
}

const useTauriDrag = () => {
  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (IS_MAC_OS) return;
    const resizeInfo = getResizeDirection(event.clientX, event.clientY);
    updateResizeCursor(resizeInfo?.cursor || '');
  }, []);

  const handleMouseDown = useCallback((event: MouseEvent) => {
    if (event.button !== 0) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest(NO_DRAG_ELEMENTS)) return;

    const tauriWindow = getTauriWindowSync();
    if (!tauriWindow) return;

    // Check border resize first (non-macOS)
    if (!IS_MAC_OS) {
      const resizeInfo = getResizeDirection(event.clientX, event.clientY);
      if (resizeInfo && typeof tauriWindow.startResizeDragging === 'function') {
        event.preventDefault();
        void tauriWindow.startResizeDragging(resizeInfo.direction);
        return;
      }
    }

    // Check window drag on top area, headers, or any element with data-tauri-drag-region
    const isDragArea = Boolean(
      event.clientY <= 36
      || event.target.closest('[data-tauri-drag-region]')
      || event.target.closest('#LeftMainHeader')
      || event.target.closest('.left-header')
      || event.target.closest('.MiddleHeader')
      || event.target.closest('.RightHeader')
      || event.target.closest('.tauri-drag-region'),
    );

    if (isDragArea && typeof tauriWindow.startDragging === 'function') {
      void tauriWindow.startDragging();
    }
  }, []);

  const handleDoubleClick = useCallback((event: MouseEvent) => {
    if (event.button !== 0) return;
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest(NO_DRAG_ELEMENTS)) return;

    const isDragArea = Boolean(
      event.clientY <= 36
      || event.target.closest('[data-tauri-drag-region]')
      || event.target.closest('#LeftMainHeader')
      || event.target.closest('.left-header')
      || event.target.closest('.MiddleHeader')
      || event.target.closest('.RightHeader')
      || event.target.closest('.tauri-drag-region'),
    );

    if (isDragArea) {
      const tauriWindow = getTauriWindowSync();
      if (tauriWindow && typeof tauriWindow.toggleMaximize === 'function') {
        void tauriWindow.toggleMaximize();
      }
    }
  }, []);

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('dblclick', handleDoubleClick);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('dblclick', handleDoubleClick);
      updateResizeCursor('');
    };
  }, [handleDoubleClick, handleMouseDown, handleMouseMove]);
};

export default useTauriDrag;
