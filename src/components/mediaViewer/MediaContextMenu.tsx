import type { ElementRef } from '../../lib/teact/teact';
import { useLayoutEffect, useRef, useState } from '../../lib/teact/teact';

import type { IconName } from '../../types/icons';
import type { RegularLangKey } from '../../types/language';

import stopEvent from '../../util/stopEvent';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import Menu from '../ui/Menu';
import MenuItem from '../ui/MenuItem';

import './MediaContextMenu.scss';

export type MediaContextAction = {
  icon: IconName;
  label: RegularLangKey;
  run: NoneToVoidFunction;
};

type OwnProps = {
  mediaRef: ElementRef<HTMLElement>;
  actions: MediaContextAction[];
};

const VIEWPORT_MARGIN = 8;

const MediaContextMenu = ({ mediaRef, actions }: OwnProps) => {
  const lang = useLang();
  const triggerRef = useRef<HTMLButtonElement>();
  const hostRef = useRef<HTMLDivElement>();
  const menuRef = useRef<HTMLDivElement>();
  const focusRef = useRef<HTMLElement>();
  const [anchor, setAnchor] = useState<{ x: number; y: number }>();

  const close = useLastCallback(() => {
    setAnchor(undefined);
    focusRef.current?.focus({ preventScroll: true });
    focusRef.current = undefined;
  });

  const openFromKeyboard = useLastCallback((element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    focusRef.current = element;
    setAnchor({ x: bounds.left, y: element === triggerRef.current ? bounds.bottom : bounds.top });
  });

  useLayoutEffect(() => {
    const media = mediaRef.current;
    if (!media) return undefined;

    const context = (event: MouseEvent) => {
      stopEvent(event);
      focusRef.current = media;
      setAnchor({ x: event.clientX, y: event.clientY });
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      stopEvent(event);
      openFromKeyboard(media);
    };

    media.addEventListener('contextmenu', context);
    media.addEventListener('keydown', keyboard);
    return () => {
      media.removeEventListener('contextmenu', context);
      media.removeEventListener('keydown', keyboard);
    };
  }, [mediaRef, openFromKeyboard]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const menu = menuRef.current;
    if (!anchor || !host || !menu) return undefined;

    host.popover = 'manual';
    host.showPopover?.();
    host.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(anchor.x,
      document.documentElement.clientWidth - menu.offsetWidth - VIEWPORT_MARGIN))}px`;
    host.style.top = `${Math.max(VIEWPORT_MARGIN, Math.min(anchor.y,
      document.documentElement.clientHeight - menu.offsetHeight - VIEWPORT_MARGIN))}px`;
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', close);
    document.addEventListener('fullscreenchange', close);

    return () => {
      host.hidePopover?.();
      window.removeEventListener('resize', close);
      document.removeEventListener('fullscreenchange', close);
    };
  }, [anchor, close]);

  const label = lang('RelayMediaActions');
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="Button round MediaContextTrigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => {
          stopEvent(event);
          if (anchor) close();
          else if (triggerRef.current) openFromKeyboard(triggerRef.current);
        }}
      >
        <Icon name="more" />
      </button>
      {anchor && (
        <div ref={hostRef} className="MediaContextHost" onContextMenu={stopEvent}>
          <Menu
            ref={menuRef}
            isOpen
            autoClose
            nested
            className="MediaContextMenu"
            ariaLabel={label}
            onClose={close}
          >
            {actions.map(({ icon, label: actionLabel, run }) => (
              <MenuItem key={actionLabel} icon={icon} onClick={run}>{lang(actionLabel)}</MenuItem>
            ))}
          </Menu>
        </div>
      )}
    </>
  );
};

export default MediaContextMenu;
