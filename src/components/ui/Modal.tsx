import type { ElementRef, TeactNode } from '../../lib/teact/teact';
import {
  beginHeavyAnimation, useEffect, useLayoutEffect, useRef,
} from '../../lib/teact/teact';

import type { TextPart } from '../../types';

import { requestMeasure } from '../../lib/fasterdom/fasterdom';
import buildClassName from '../../util/buildClassName';
import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../../util/captureKeyboardListeners';
import { disableDirectTextInput, enableDirectTextInput } from '../../util/directInputManager';
import acquireOpenModal from '../../util/openModalState';
import trapFocus from '../../util/trapFocus';

import useContextMenuHandlers from '../../hooks/useContextMenuHandlers';
import useFrozenProps from '../../hooks/useFrozenProps';
import useHistoryBack from '../../hooks/useHistoryBack';
import useLastCallback from '../../hooks/useLastCallback';
import useLayoutEffectWithPrevDeps from '../../hooks/useLayoutEffectWithPrevDeps';
import useOldLang from '../../hooks/useOldLang';
import useShowTransition from '../../hooks/useShowTransition';
import useSyncEffect from '../../hooks/useSyncEffect';
import useUniqueId from '../../hooks/useUniqueId';

import Button, { type OwnProps as ButtonProps } from './Button';
import Menu from './Menu';
import ModalStarBalanceBar from './ModalStarBalanceBar';
import Portal from './Portal';

import './Modal.scss';

export const ANIMATION_DURATION = 200;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export type OwnProps = {
  title?: string | TextPart[];
  ariaLabel?: string;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  dialogClassName?: string;
  isOpen?: boolean;
  header?: TeactNode;
  isSlim?: boolean;
  hasCloseButton?: boolean;
  hasAbsoluteCloseButton?: boolean;
  absoluteCloseButtonColor?: ButtonProps['color'];
  isBackButton?: boolean;
  noBackdrop?: boolean;
  noBackdropClose?: boolean;
  isNativeDialog?: boolean;
  noTitleAutoFocus?: boolean;
  children: React.ReactNode;
  style?: string;
  dialogStyle?: string;
  dialogRef?: ElementRef<HTMLDivElement>;
  isLowStackPriority?: boolean;
  dialogContent?: React.ReactNode;
  moreMenuItems?: TeactNode;
  headerRightToolBar?: TeactNode;
  withBalanceBar?: boolean;
  currencyInBalanceBar?: 'TON' | 'XTR';
  isCondensedHeader?: boolean;
  noFreezeOnClose?: boolean;
  onClose: NoneToVoidFunction;
  onCloseAnimationEnd?: NoneToVoidFunction;
  onEnter?: NoneToVoidFunction;
};

const Modal = (props: OwnProps) => {
  const {
    dialogRef,
    isOpen,
    noBackdropClose,
    noFreezeOnClose,
    isNativeDialog,
    noTitleAutoFocus,
    onClose,
    onCloseAnimationEnd,
    onEnter,
  } = props;

  const shouldDisableAnimation = reducedMotionQuery.matches || document.body.classList.contains('no-page-transitions');

  const {
    ref: modalRef,
    shouldRender,
  } = useShowTransition<HTMLElement>({
    isOpen,
    withShouldRender: true,
    noOpenTransition: shouldDisableAnimation,
    closeDuration: shouldDisableAnimation ? 0 : ANIMATION_DURATION,
    onCloseAnimationEnd,
  });

  const shouldFreeze = !noFreezeOnClose && !isOpen;
  const {
    title,
    ariaLabel,
    isLowStackPriority,
    header,
    children,
    className,
    contentClassName,
    headerClassName,
    dialogClassName,
    isSlim,
    hasCloseButton,
    hasAbsoluteCloseButton,
    absoluteCloseButtonColor = 'translucent',
    isBackButton,
    noBackdrop,
    style,
    dialogStyle,
    dialogContent,
    moreMenuItems,
    headerRightToolBar: headerToolBar,
    withBalanceBar,
    isCondensedHeader,
    currencyInBalanceBar = 'XTR',
  } = useFrozenProps(props, shouldFreeze);

  const localDialogRef = useRef<HTMLDivElement>();
  const previousFocusRef = useRef<HTMLElement>();
  const moreButtonRef = useRef<HTMLButtonElement>();
  const menuRef = useRef<HTMLDivElement>();
  const modalId = useUniqueId();
  const menuPortalId = `modal-menu-${modalId}`;
  const titleId = `modal-title-${modalId}`;

  const {
    isContextMenuOpen,
    contextMenuAnchor,
    handleContextMenu,
    handleContextMenuClose,
    handleContextMenuHide,
  } = useContextMenuHandlers(moreButtonRef);

  const actualDialogRef = dialogRef || localDialogRef;
  const divModalRef = modalRef as ElementRef<HTMLDivElement>;
  const nativeDialogRef = modalRef as ElementRef<HTMLDialogElement>;

  useEffect(() => {
    if (!isOpen) {
      handleContextMenuClose();
      handleContextMenuHide();
    }
  }, [isOpen, handleContextMenuClose, handleContextMenuHide]);

  const handleMoreMenuClose = useLastCallback((event?: KeyboardEvent) => {
    event?.preventDefault();
    handleContextMenuClose();
    moreButtonRef.current?.focus({ preventScroll: true });
  });

  const getRootElement = useLastCallback(() => actualDialogRef.current);
  const getTriggerElement = useLastCallback(() => moreButtonRef.current);
  const getMenuElement = useLastCallback(() => menuRef.current);
  const getLayout = useLastCallback(() => ({ withPortal: true }));

  const withCloseButton = hasCloseButton || hasAbsoluteCloseButton;

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    disableDirectTextInput();

    return enableDirectTextInput;
  }, [isOpen]);

  const handleEnter = useLastCallback((e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : undefined;
    if (!target || !modalRef.current?.contains(target)) {
      const owner = target?.closest('.Modal');
      if (owner && owner !== modalRef.current && owner.matches('.open, dialog[open]')
        && !owner.matches('.closing, .not-shown, .not-open')) return false;
      e.preventDefault();
      return true;
    }
    if (!onEnter || target.closest(
      'button, a[href], [role="button"], .MenuItem, [role="menuitemradio"], textarea, '
      + 'input[type="checkbox"], input[type="radio"], select, '
      + '[contenteditable="true"], [contenteditable="plaintext-only"]',
    )) {
      return ALLOW_KEYBOARD_EVENT_PROPAGATION;
    }
    e.preventDefault();
    onEnter();
    return true;
  });

  const handleSpace = useLastCallback((e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : undefined;
    if (!target || !modalRef.current?.contains(target)) return false;
    const menuItem = target.closest('.MenuItem');
    if (menuItem && !menuItem.matches('button, a[href]')) e.preventDefault();
    return ALLOW_KEYBOARD_EVENT_PROPAGATION;
  });

  const handleEscape = useLastCallback((e: KeyboardEvent) => {
    const owner = e.target instanceof Element ? e.target.closest('.Modal') : undefined;
    if (owner && owner !== modalRef.current && owner.matches('.open, dialog[open]')
      && !owner.matches('.closing, .not-shown, .not-open')) return false;
    e.preventDefault();
    onClose();
    return true;
  });

  useEffect(() => (
    isOpen ? captureKeyboardListeners({ onEsc: handleEscape, onEnter: handleEnter, onSpace: handleSpace }) : undefined
  ), [isOpen, handleEscape, handleEnter, handleSpace]);
  useSyncEffect(() => {
    previousFocusRef.current = isOpen && document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let isCancelled = false;
    let releaseFocus: NoneToVoidFunction | undefined;
    requestMeasure(() => {
      if (!isCancelled && modalRef.current) releaseFocus = trapFocus(modalRef.current, previousFocusRef.current);
    });
    return () => {
      isCancelled = true;
      releaseFocus?.();
    };
  }, [isOpen, modalRef, shouldRender]);

  useLayoutEffect(() => {
    if (!isNativeDialog || !shouldRender) {
      return undefined;
    }

    const dialog = nativeDialogRef.current;
    if (!dialog) {
      return undefined;
    }

    if (!dialog.open) {
      dialog.showModal();
    }

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [isNativeDialog, nativeDialogRef, shouldRender]);

  useEffect(() => {
    if (!isNativeDialog || !shouldRender) {
      return undefined;
    }

    const dialog = nativeDialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const handleCancel = (event: Event) => {
      event.preventDefault();

      if (isOpen) {
        onClose();
      }
    };

    dialog.addEventListener('cancel', handleCancel);

    return () => {
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [isNativeDialog, isOpen, nativeDialogRef, onClose, shouldRender]);

  useHistoryBack({
    isActive: isOpen,
    onBack: onClose,
  });

  useLayoutEffect(() => (shouldRender ? acquireOpenModal() : undefined), [shouldRender]);

  useLayoutEffectWithPrevDeps(([prevIsOpen]) => {
    if (!shouldDisableAnimation && (isOpen || (!isOpen && prevIsOpen !== undefined))) {
      beginHeavyAnimation(ANIMATION_DURATION);
    }
  }, [isOpen, shouldDisableAnimation]);

  const lang = useOldLang();

  if (!shouldRender) {
    return undefined;
  }

  function renderHeader() {
    if (header) {
      return header;
    }

    const closeIconClassName = buildClassName(
      'animated-close-icon',
      isBackButton && 'state-back',
    );

    const closeButton = withCloseButton ? (
      <Button
        className={buildClassName(hasAbsoluteCloseButton && 'modal-absolute-close-button')}
        round
        color={absoluteCloseButtonColor}
        size="tiny"
        ariaLabel={isBackButton ? lang('Back') : lang('Close')}
        onClick={onClose}
      >
        <div className={closeIconClassName} />
      </Button>
    ) : undefined;

    return title ? (
      <div className={buildClassName('modal-header', headerClassName, isCondensedHeader && 'modal-header-condensed')}>
        {closeButton}
        <div
          id={titleId}
          className="modal-title"
          title={typeof title === 'string' ? title : undefined}
          autoFocus={!noTitleAutoFocus}
        >
          {title}
        </div>
      </div>
    ) : closeButton;
  }

  const fullClassName = buildClassName(
    'Modal',
    className,
    noBackdrop && 'transparent-backdrop',
    isSlim && 'slim',
    isLowStackPriority && 'low-priority',
    withBalanceBar && 'with-balance-bar',
  );

  const modalDialogClassName = buildClassName(
    'modal-dialog',
    dialogClassName,
  );

  function renderContent() {
    return (
      <>
        <div className="modal-container" id={menuPortalId}>
          <div className="modal-backdrop" onClick={!noBackdropClose ? onClose : undefined} />
          {withBalanceBar && (
            <ModalStarBalanceBar
              isModalOpen={isOpen}
              currency={currencyInBalanceBar}
            />
          )}
          <div className={modalDialogClassName} ref={actualDialogRef} style={dialogStyle}>
            {renderHeader()}
            {headerToolBar}
            {Boolean(moreMenuItems) && (
              <>
                <Button
                  ref={moreButtonRef}
                  className="modal-more-button"
                  round
                  color={absoluteCloseButtonColor}
                  size="tiny"
                  iconName="more"
                  ariaLabel={lang('AriaMoreButton')}
                  onClick={handleContextMenu}
                  onContextMenu={handleContextMenu}
                />
                {isOpen && contextMenuAnchor && (
                  <Menu
                    ref={menuRef}
                    isOpen={isContextMenuOpen}
                    anchor={contextMenuAnchor}
                    autoClose
                    withPortal
                    portalContainerSelector={`#${menuPortalId}`}
                    positionX="right"
                    onClose={handleMoreMenuClose}
                    onCloseAnimationEnd={handleContextMenuHide}
                    getRootElement={getRootElement}
                    getTriggerElement={getTriggerElement}
                    getMenuElement={getMenuElement}
                    getLayout={getLayout}
                  >
                    {moreMenuItems}
                  </Menu>
                )}
              </>
            )}
            {dialogContent}
            <div className={buildClassName('modal-content custom-scroll', contentClassName)} style={style}>
              {children}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <Portal>
      {isNativeDialog ? (
        <dialog
          ref={nativeDialogRef}
          className={fullClassName}
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={title && !header ? titleId : undefined}
        >
          {renderContent()}
        </dialog>
      ) : (
        <div
          ref={divModalRef}
          className={fullClassName}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={title && !header ? titleId : undefined}
        >
          {renderContent()}
        </div>
      )}
    </Portal>
  );
};

export default Modal;
