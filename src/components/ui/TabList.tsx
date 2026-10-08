import type { TeactNode } from '../../lib/teact/teact';
import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';

import type { IAnchorPosition } from '../../types';
import type { MenuItemContextAction } from './ListItem';
import type { TabWithProperties } from './SquareTabList';

export type { TabWithProperties };

import buildClassName from '../../util/buildClassName';
import renderText from '../common/helpers/renderText';

import { handleFileHoverOpenEvent } from '../../hooks/useFileHoverOpen';
import useFlag from '../../hooks/useFlag';
import useHorizontalScroll from '../../hooks/useHorizontalScroll';
import useLastCallback from '../../hooks/useLastCallback';
import useResizeObserver from '../../hooks/useResizeObserver';
import useScrollToActiveTab from '../../hooks/useScrollToActiveTab';

import CustomEmoji from '../common/CustomEmoji';
import Icon from '../common/icons/Icon';
import Menu from './Menu';
import MenuItem from './MenuItem';
import MenuSeparator from './MenuSeparator';

import styles from './TabList.module.scss';

const EMOJI_SIZE = 20;

type OwnProps = {
  tabs: readonly TabWithProperties[];
  activeTab: number;
  className?: string;
  tabClassName?: string;
  indicatorClassName?: string;
  centered?: boolean;
  stretched?: boolean;
  itemAlignment?: 'vertical' | 'horizontal';
  withFadeMask?: boolean;
  fadeMaskClassName?: string;
  onSwitchTab: (index: number) => void;
  renderExtra?: (tab: TabWithProperties, index: number) => TeactNode;
  onFileHoverOpen?: (index: number) => void;
};

const TabList = ({
  tabs,
  activeTab,
  className,
  tabClassName,
  indicatorClassName,
  centered,
  stretched,
  itemAlignment,
  withFadeMask,
  fadeMaskClassName,
  renderExtra,
  onSwitchTab,
  onFileHoverOpen,
}: OwnProps) => {
  const containerRef = useRef<HTMLDivElement>();
  const clipPathContainerRef = useRef<HTMLDivElement>();
  const [clipPath, setClipPath] = useState<string>('');
  const [isMenuOpen, openMenu, closeMenu] = useFlag();
  const [menuAnchor, setMenuAnchor] = useState<IAnchorPosition | undefined>();
  const [menuTabIndex, setMenuTabIndex] = useState<number | undefined>();
  const menuTargetRef = useRef<HTMLElement>();

  useHorizontalScroll(containerRef, !tabs.length, true);

  const updateClipPath = useLastCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const tabEls = container.querySelectorAll<HTMLElement>(`.${styles.tab}`);
    const activeTabEl = activeTab >= 0 ? tabEls[activeTab] : undefined;

    if (activeTabEl && container.offsetWidth > 0) {
      const { offsetLeft, offsetWidth } = activeTabEl;
      const containerWidth = container.offsetWidth;
      const left = (offsetLeft / containerWidth * 100).toFixed(1);
      const right = ((containerWidth - (offsetLeft + offsetWidth)) / containerWidth * 100).toFixed(1);

      setClipPath(`inset(0.25rem ${right}% 0.25rem ${left}% round var(--tab-radius))`);
    } else if (activeTab < 0) {
      setClipPath('inset(0 100% 0 100%)');
    }
  });

  useEffect(() => {
    updateClipPath();
  }, [activeTab, tabs]);

  useResizeObserver(containerRef, updateClipPath);

  useScrollToActiveTab(containerRef, activeTab);

  const isMouseDownRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      isMouseDownRef.current = true;
      isDraggingRef.current = false;
      startXRef.current = e.pageX;
      scrollLeftRef.current = container.scrollLeft;
      container.style.cursor = 'grabbing';
      container.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isMouseDownRef.current) return;
      const walk = e.pageX - startXRef.current;
      if (Math.abs(walk) > 4) {
        isDraggingRef.current = true;
      }
      container.scrollLeft = scrollLeftRef.current - walk;
    };

    const onMouseUp = () => {
      if (!isMouseDownRef.current) return;
      isMouseDownRef.current = false;
      container.style.cursor = '';
      container.style.userSelect = '';
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 50);
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleTabClick = useLastCallback((index: number) => {
    if (isDraggingRef.current) return;
    onSwitchTab(index);
  });

  const handleTabKeyDown = useLastCallback((index: number, e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleTabClick(index);
      return;
    }

    const isVertical = itemAlignment === 'vertical';
    const lastIndex = tabs.length - 1;
    let nextIndex: number | undefined;
    if (e.key === (isVertical ? 'ArrowDown' : 'ArrowRight')) nextIndex = index >= lastIndex ? 0 : index + 1;
    if (e.key === (isVertical ? 'ArrowUp' : 'ArrowLeft')) nextIndex = index <= 0 ? lastIndex : index - 1;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = lastIndex;
    if (nextIndex === undefined) return;

    e.preventDefault();
    handleTabClick(nextIndex);
    containerRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();
  });

  const handleFileHoverOpen = useLastCallback((index: number, e: Event) => {
    handleFileHoverOpenEvent(e, () => onFileHoverOpen!(index));
  });

  const handleContextMenu = useLastCallback((index: number, e: React.MouseEvent) => {
    const actions = tabs[index]?.contextActions;
    if (!actions?.length) return;
    e.preventDefault();
    menuTargetRef.current = e.currentTarget as HTMLElement;
    setMenuTabIndex(index);
    setMenuAnchor({ x: e.clientX, y: e.clientY });
    openMenu();
  });

  const handleMenuClose = useLastCallback(() => {
    closeMenu();
  });

  const handleMenuHide = useLastCallback(() => {
    setMenuAnchor(undefined);
    setMenuTabIndex(undefined);
  });

  const getTriggerElement = useLastCallback(() => menuTargetRef.current);
  const getRootElement = useLastCallback(() => containerRef.current);
  const getMenuElement = useLastCallback(
    () => containerRef.current?.querySelector<HTMLElement>('.TabList-context-menu .bubble'),
  );
  const getLayout = useLastCallback(() => ({ withPortal: true }));

  if (!tabs.length) return undefined;

  const hasContextActions = tabs.some((tab) => tab.contextActions?.length);

  const renderTab = (tab: TabWithProperties, index: number) => {
    const customEmojiId = tab.customEmojiDocumentId
      || (typeof tab.emoticon === 'object' ? tab.emoticon.documentId : undefined);
    const stringEmoticon = typeof tab.emoticon === 'string' ? tab.emoticon : undefined;
    const isActive = index === activeTab;

    return (
      <div
        key={tab.id ?? index}
        className={buildClassName(
          styles.tab,
          tabClassName,
          isActive && styles.tabActive,
          itemAlignment === 'vertical' && styles.vertical,
          stretched && styles.stretched,
        )}
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive || (activeTab < 0 && index === 0) ? 0 : -1}
        onClick={() => handleTabClick(index)}
        onKeyDown={(e) => handleTabKeyDown(index, e)}
        data-file-hover-open={onFileHoverOpen ? true : undefined}
        onFileHoverOpen={onFileHoverOpen ? (e) => handleFileHoverOpen(index, e) : undefined}
        onContextMenu={hasContextActions ? (e) => handleContextMenu(index, e) : undefined}
      >
        {stringEmoticon && <span className={styles.tabEmoji}>{stringEmoticon}</span>}
        {customEmojiId && (
          <CustomEmoji
            documentId={customEmojiId}
            className={styles.tabEmoji}
            size={EMOJI_SIZE}
            shouldNotLoop
          />
        )}
        {tab.icon && <Icon name={tab.icon} className={styles.tabIcon} />}
        <span className={styles.tabTitle}>
          {typeof tab.title === 'string' ? renderText(tab.title) : tab.title}
        </span>
        {renderExtra?.(tab, index)}
        {tab.isBlocked && <Icon name="lock-badge" className={styles.lockIcon} />}
      </div>
    );
  };

  const contextActions = menuTabIndex !== undefined ? tabs[menuTabIndex]?.contextActions : undefined;

  const tabListElement = (
    <div
      ref={containerRef}
      role="tablist"
      aria-orientation={itemAlignment === 'vertical' ? 'vertical' : 'horizontal'}
      className={buildClassName(
        'TabList',
        styles.container,
        withFadeMask && styles.withFadeMask,
        centered && styles.centered,
        itemAlignment === 'vertical' && styles.vertical,
        className,
        clipPath && styles.ready,
      )}
    >
      <div
        ref={clipPathContainerRef}
        className={buildClassName(styles.activeIndicator,
          centered && styles.centered,
          stretched && styles.stretched,
          indicatorClassName)}
        style={clipPath ? `clip-path: ${clipPath}` : undefined}
        aria-hidden
      />
      {tabs.map(renderTab)}
    </div>
  );

  const menuElement = contextActions && menuAnchor !== undefined && (
    <Menu
      isOpen={isMenuOpen}
      anchor={menuAnchor}
      getTriggerElement={getTriggerElement}
      getRootElement={getRootElement}
      getMenuElement={getMenuElement}
      getLayout={getLayout}
      className="TabList-context-menu"
      autoClose
      onClose={handleMenuClose}
      onCloseAnimationEnd={handleMenuHide}
      withPortal
    >
      {contextActions.map((action: MenuItemContextAction) => (
        ('isSeparator' in action) ? (
          <MenuSeparator key={action.key || `separator-${contextActions.indexOf(action)}`} />
        ) : (
          <MenuItem
            key={action.title}
            icon={action.icon}
            destructive={action.destructive}
            disabled={!action.handler}
            onClick={action.handler}
          >
            {renderText(action.title)}
          </MenuItem>
        )
      ))}
    </Menu>
  );

  if (!withFadeMask) {
    return (
      <>
        {tabListElement}
        {menuElement}
      </>
    );
  }

  return (
    <>
      <div className={buildClassName(styles.fadeMaskWrapper, fadeMaskClassName)}>
        {tabListElement}
      </div>
      {menuElement}
    </>
  );
};

export default memo(TabList);
