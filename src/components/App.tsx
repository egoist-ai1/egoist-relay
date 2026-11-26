import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from '../lib/teact/teact';
import { addCallback, removeCallback } from '../lib/teact/teactn';
import { getActions, getGlobal, withGlobal } from '../global';

import type { GlobalState } from '../global/types';
import type { ThemeKey } from '../types';
import type { SocialNavigationAction } from './common/Titlebar';
import type { UiLoaderPage } from './common/UiLoader';
import type { AppId, InstagramAppState, XAppState } from './multi/AppSidebar';
import type { PalettePayload } from './multi/commandPalette.index';
import type { MediaOperation, MediaOperationsSnapshot } from './multi/mediaOperations.types';
import type { SocialShareRequest, SocialShareSuccess } from './multi/socialShare';
import { LeftColumnContent } from '../types';

import {
  DARK_THEME_BG_COLOR, INACTIVE_MARKER, LIGHT_THEME_BG_COLOR, PAGE_TITLE, PAGE_TITLE_TAURI,
} from '../config';
import { requestMeasure } from '../lib/fasterdom/fasterdom';
import { forceMutation } from '../lib/fasterdom/stricterdom.ts';
import {
  selectActionMessageBg, selectSettingsKeys, selectTabState, selectTheme, selectThemeValues,
} from '../global/selectors';
import { selectSharedSettings } from '../global/selectors/sharedState';
import { IS_TAURI } from '../util/browser/globalEnvironment';
import {
  IS_INSTALL_PROMPT_SUPPORTED, IS_MAC_OS, IS_WINDOWS, PLATFORM_ENV,
} from '../util/browser/windowEnvironment';
import buildClassName from '../util/buildClassName';
import { clearStoredMediaCache } from '../util/cacheApi';
import { handleError } from '../util/handleError';
import { parseInlineSocialMediaUrl } from '../util/inlineSocialMedia';
import { setupBeforeInstallPrompt } from '../util/installPrompt';
import { ACCOUNT_SLOT, getAccountSlotUrl, getFirstLoggedInAccountSlot } from '../util/multiaccount';
import { hasEncryptedSession } from '../util/passcode';
import { getInitialLocationHash, parseInitialLocationHash } from '../util/routing';
import { checkSessionLocked, hasStoredSession } from '../util/sessions';
import { resolveAppBounds } from '../util/tauri/appBounds';
import { MAX_NATIVE_LINKS, normalizeNativeDeepLinks } from '../util/tauri/deepLinks';
import { startSocialWarmup, WARMUP_READY_DELAY_MS } from '../util/tauri/socialWarmup';
import { getActionMessageBg, getWallpaperBaseColor } from '../util/wallpaper';
import { updateSizes } from '../util/windowSize';
import { isComposerHasSelection } from './middle/composer/helpers/selection';
import { getMediaOperationsSnapshot, setMediaOperationsLocked,
  subscribeMediaOperations } from './multi/mediaOperations';
import { isMediaOperationActive } from './multi/mediaOperations.types';
import { isSocialShareRequest } from './multi/socialShare';

import useTauriDrag from '../hooks/tauri/useTauriDrag';
import useAppLayout from '../hooks/useAppLayout';
import useFileHoverOpen, {
  FILE_HOVER_OPEN_SELECTOR, hasFiles,
} from '../hooks/useFileHoverOpen';
import useLang from '../hooks/useLang';
import useLastCallback from '../hooks/useLastCallback';
import usePrevious from '../hooks/usePrevious';
import useResizeObserver from '../hooks/useResizeObserver';
import { useSignalEffect } from '../hooks/useSignalEffect';
import { getIsInBackground } from '../hooks/window/useBackgroundMode';

import Auth from './auth/Auth';
import Notifications from './common/Notifications';
import Titlebar from './common/Titlebar';
import UiLoader from './common/UiLoader';
import AppInactive from './main/AppInactive';
import LockScreen from './main/LockScreen.async';
import Main from './main/Main.async';
import AppSidebar from './multi/AppSidebar';
import CommandPalette from './multi/CommandPalette';
import MediaOperationsPanel from './multi/MediaOperationsPanel';
import NoticeHistoryModal from './multi/NoticeHistoryModal';
import RelayAppSettingsModal from './multi/RelayAppSettingsModal';
import SocialShareModal from './multi/SocialShareModal';
// import Test from './test/demo/MessageTextStreamingTest';
import ConfirmDialog from './ui/ConfirmDialog';
import Transition from './ui/Transition';

import styles from './App.module.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
  isSynced?: boolean;
  isScreenLocked?: boolean;
  hasPasscode?: boolean;
  inactiveReason?: 'auth' | 'otherClient';
  hasWebAuthTokenFailed?: boolean;
  isTestServer?: boolean;
  shouldHideX?: boolean;
  shouldHideInstagram?: boolean;
  hasWebNotifications: boolean;
  notificationSoundVolume: number;
  theme: ThemeKey;
  customBackgroundColor?: string;
  actionMessageBg?: string;
};

enum AppScreens {
  auth,
  main,
  lock,
  inactive,
}

const TRANSITION_RENDER_COUNT = Object.keys(AppScreens).length / 2;
const ACTIVE_PAGE_TITLE = IS_TAURI ? PAGE_TITLE_TAURI : PAGE_TITLE;
const INACTIVE_PAGE_TITLE = `${ACTIVE_PAGE_TITLE} ${INACTIVE_MARKER}`;
const NOTICE_DURATION = 6000;
const HAS_NOTICE_HISTORY = IS_TAURI && IS_WINDOWS;
const PREWARM_COMMANDS = ['multi_prewarm_x', 'multi_prewarm_instagram'] as const;
const PREWARM_COMMAND_APPS: Record<(typeof PREWARM_COMMANDS)[number], AppId> = {
  multi_prewarm_x: 'x',
  multi_prewarm_instagram: 'instagram',
};

function publishWorkspaceCoverage(covered: boolean) {
  const value = String(covered);
  if (document.documentElement.dataset.relayNativeCovered === value) return;
  document.documentElement.dataset.relayNativeCovered = value;
  window.dispatchEvent(new Event('egoist-relay-workspace-visibility'));
}

function buildHiddenApps(shouldHideX?: boolean, shouldHideInstagram?: boolean) {
  const hiddenApps: AppId[] = [];
  if (shouldHideX) hiddenApps.push('x');
  if (shouldHideInstagram) hiddenApps.push('instagram');
  return hiddenApps;
}

type XStatusPayload = {
  state: Exclude<XAppState, 'idle'>;
  url?: string;
  message?: string;
};

type XFailureDetails = { reason: 'timeout' | 'browser' } | { reason: 'navigation'; code: number };

function parseXFailureDetails(message: unknown): XFailureDetails | undefined {
  if (typeof message !== 'string') return undefined;
  if (/^The service did not become ready within \d{1,3} seconds$/.test(message)) return { reason: 'timeout' };
  if (message === 'The service browser process stopped responding') return { reason: 'browser' };

  const match = /^The service navigation failed: COREWEBVIEW2_WEB_ERROR_STATUS\((\d{1,2})\)$/.exec(message)
    ?? /^The service navigation failed: WebErrorStatus (\d{1,2})$/.exec(message);
  if (!match || match[0] !== message) return undefined;

  const code = Number(match[1]);
  if (code > 18) return undefined;
  if (code === 7) return { reason: 'timeout' };
  return { reason: 'navigation', code };
}

type InstagramStatusPayload = {
  state: Exclude<InstagramAppState, 'idle'>;
  url?: string;
  message?: string;
};

type SocialAppId = Exclude<AppId, 'telegram'>;
type ServiceHistory = { canGoBack: boolean; canGoForward: boolean };
type ServiceHistoryPayload = ServiceHistory & { service: SocialAppId };

type DownloadStatusPayload = {
  success: boolean;
  service?: AppId;
  fileName?: string;
  error?: string;
};

type WebviewCacheReport = Record<AppId, 'cleared' | 'deferred' | 'failed'>;

function getDownloadNoticeKey({ success, error }: DownloadStatusPayload) {
  if (success) return 'RelayDownloadSaved';
  if (error === 'MEDIA_TYPE_BLOCKED') return 'RelayDownloadBlocked';
  if (error === 'MEDIA_TOO_LARGE' || error === 'MEDIA_RATE_LIMITED' || error === 'MEDIA_QUEUE_FULL') {
    return 'RelayDownloadLimited';
  }
  return 'RelayDownloadFailed';
}

const App = ({
  authState,
  isSynced,
  isScreenLocked,
  hasPasscode,
  inactiveReason,
  hasWebAuthTokenFailed,
  isTestServer,
  shouldHideX,
  shouldHideInstagram,
  hasWebNotifications,
  notificationSoundVolume,
  theme,
  customBackgroundColor,
  actionMessageBg,
}: StateProps) => {
  const { isMobile } = useAppLayout();
  const [activeApp, setActiveApp] = useState<AppId>('telegram');
  const [pendingTelegramLinks, setPendingTelegramLinks] = useState<string[]>([]);
  const [xAppState, setXAppState] = useState<XAppState>('idle');
  const [xFailureDetails, setXFailureDetails] = useState<XFailureDetails>();
  const [instagramAppState, setInstagramAppState] = useState<InstagramAppState>('idle');
  const [serviceHistory, setServiceHistory] = useState<Partial<Record<SocialAppId, ServiceHistory>>>({});
  const [sleepingApps, setSleepingApps] = useState<AppId[]>([]);
  const [isNavigating, setIsNavigating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [isOperationsOpen, setIsOperationsOpen] = useState(false);
  const [operationsInitialSection, setOperationsInitialSection] = useState<'saved'>();
  const [isOperationsFull, setIsOperationsFull] = useState(false);
  const [isAppSettingsOpen, setIsAppSettingsOpen] = useState(false);
  const [areAppSettingsVisible, setAreAppSettingsVisible] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isPaletteVisible, setIsPaletteVisible] = useState(false);
  const [isNoticeHistoryOpen, setIsNoticeHistoryOpen] = useState(false);
  const [isNoticeHistoryVisible, setIsNoticeHistoryVisible] = useState(false);
  const [isCacheDialogOpen, setIsCacheDialogOpen] = useState(false);
  const [isCacheDialogVisible, setIsCacheDialogVisible] = useState(false);
  const [isClearingCache, setIsClearingCache] = useState(false);
  const isClearingCacheRef = useRef(false);
  const cacheDialogOriginRef = useRef<HTMLElement>();
  const [operationsSnapshot, setOperationsSnapshot] = useState<MediaOperationsSnapshot>(getMediaOperationsSnapshot);
  const workspaceRef = useRef<HTMLDivElement>();
  const previousFocusRef = useRef<HTMLElement>();
  const paletteOriginRef = useRef<HTMLElement>();
  const noticeHistoryOriginRef = useRef<HTMLElement>();
  const [socialShare, setSocialShare] = useState<SocialShareRequest>();
  const [shareRecovery, setShareRecovery] = useState<MediaOperation>();
  const recoveryRequestRef = useRef<MediaOperation>();
  const socialShareRef = useRef<SocialShareRequest>();
  const isMountedRef = useRef(true);
  const desiredAppRef = useRef<AppId>('telegram');
  const appSwitchRequestRef = useRef(0);
  const appSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  const navigationRequestRef = useRef(0);
  const isNavigatingRef = useRef(false);
  const nativeStatusListenersReadyRef = useRef<Promise<void>>();
  const nativeStatusListenersRef = useRef<NoneToVoidFunction[]>([]);
  const areServicesPrewarmedRef = useRef(false);
  const stopSocialWarmupRef = useRef<(() => void) | undefined>();
  const nativeViewportRef = useRef<HTMLDivElement>();
  const nativeBoundsRequestRef = useRef(0);
  const lastNativeBoundsRef = useRef<ReturnType<typeof resolveAppBounds>>();
  const workspaceGenerationRef = useRef(Math.floor(performance.timeOrigin * 1000));
  const notificationSettings = useMemo(() => {
    if (!HAS_NOTICE_HISTORY) return undefined;
    const isEnabled = hasWebNotifications && !inactiveReason;
    return {
      xEnabled: isEnabled && !shouldHideX,
      instagramEnabled: isEnabled && !shouldHideInstagram,
      volume: Math.round(Math.min(Math.max(notificationSoundVolume, 0), 10)),
    };
  }, [hasWebNotifications, inactiveReason, shouldHideX, shouldHideInstagram, notificationSoundVolume]);
  const workspaceVisibilityRef = useRef<{
    covered: boolean;
    locked: boolean;
    notificationSettings: typeof notificationSettings;
    result: Promise<boolean>;
  }>();
  const [isTitlebarMenuCovering, setIsTitlebarMenuCovering] = useState(false);
  const [isCacheDialogPreparing, setIsCacheDialogPreparing] = useState(false);
  const settingsOriginRef = useRef<HTMLElement>();
  const hiddenApps = useMemo(
    () => buildHiddenApps(shouldHideX, shouldHideInstagram),
    [shouldHideX, shouldHideInstagram],
  );
  const lang = useLang();
  const isMobileOs = PLATFORM_ENV === 'iOS' || PLATFORM_ENV === 'Android';

  const measureNativeBounds = useLastCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const currentWindow = getCurrentWindow();
    const [physicalSize, scale] = await Promise.all([currentWindow.innerSize(), currentWindow.scaleFactor()]);
    return new Promise<ReturnType<typeof resolveAppBounds>>((resolve, reject) => {
      requestMeasure(() => {
        try {
          const element = nativeViewportRef.current;
          if (!element || !Number.isFinite(scale) || scale <= 0) throw new Error('Relay viewport is unavailable');
          resolve(resolveAppBounds(element.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            { width: physicalSize.width / scale, height: physicalSize.height / scale }));
        } catch (error) {
          reject(error);
        }
      });
    });
  });

  const prepareNativeStatusListeners = useLastCallback(() => {
    if (nativeStatusListenersReadyRef.current) return nativeStatusListenersReadyRef.current;

    async function registerStatusListeners() {
      const { listen } = await import('@tauri-apps/api/event');
      if (!isMountedRef.current) return;

      const releaseX = await listen<XStatusPayload>('multi-x-status', ({ payload }) => {
        if (!isMountedRef.current) return;
        setXAppState(payload.state);
        setXFailureDetails(payload.state === 'error' ? parseXFailureDetails(payload.message) : undefined);
      });
      if (!isMountedRef.current) {
        releaseX();
        return;
      }
      nativeStatusListenersRef.current.push(releaseX);

      const releaseInstagram = await listen<InstagramStatusPayload>('multi-instagram-status', ({ payload }) => {
        if (isMountedRef.current) setInstagramAppState(payload.state);
      });
      if (!isMountedRef.current) {
        releaseInstagram();
        return;
      }
      nativeStatusListenersRef.current.push(releaseInstagram);

      const releaseHistory = await listen<ServiceHistoryPayload>('multi-service-history', ({ payload }) => {
        if (!isMountedRef.current || !payload) return;
        const { service, canGoBack, canGoForward } = payload;
        if ((service !== 'x' && service !== 'instagram')
          || typeof canGoBack !== 'boolean' || typeof canGoForward !== 'boolean') return;
        setServiceHistory((current) => {
          const previous = current[service];
          if (previous?.canGoBack === canGoBack && previous.canGoForward === canGoForward) return current;
          return { ...current, [service]: { canGoBack, canGoForward } };
        });
      });
      if (!isMountedRef.current) releaseHistory();
      else nativeStatusListenersRef.current.push(releaseHistory);
    }

    nativeStatusListenersReadyRef.current = registerStatusListeners().catch((err) => {
      nativeStatusListenersRef.current.forEach((release) => release());
      nativeStatusListenersRef.current = [];
      nativeStatusListenersReadyRef.current = undefined;
      throw err;
    });
    return nativeStatusListenersReadyRef.current;
  });

  const activateNativeApp = useLastCallback(async (app: AppId, requestId: number) => {
    if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
    await prepareNativeStatusListeners();
    if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
    const bounds = app === 'telegram' ? undefined : await measureNativeBounds();
    const { invoke } = await import('@tauri-apps/api/core');
    if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
    await invoke('multi_set_active_app', { app, bounds });
  });

  const updateNativeBounds = useLastCallback(async () => {
    if (!IS_TAURI || desiredAppRef.current === 'telegram') return;
    const app = desiredAppRef.current;
    const requestId = ++nativeBoundsRequestRef.current;
    try {
      const bounds = await measureNativeBounds();
      const { invoke } = await import('@tauri-apps/api/core');
      if (!isMountedRef.current || requestId !== nativeBoundsRequestRef.current) return;
      const previous = lastNativeBoundsRef.current;
      if (previous && bounds.x === previous.x && bounds.y === previous.y
        && bounds.width === previous.width && bounds.height === previous.height) return;
      await invoke('multi_update_x_bounds', { app, bounds });
      if (requestId === nativeBoundsRequestRef.current) lastNativeBoundsRef.current = bounds;
    } catch (error) {
      handleError(new Error('Failed to update service viewport', { cause: error }));
    }
  });
  useResizeObserver(nativeViewportRef, updateNativeBounds, !IS_TAURI);

  const applyWorkspaceVisibility = useLastCallback((covered: boolean) => {
    if (!IS_TAURI) return Promise.resolve(true);
    const locked = Boolean(getGlobal().passcode?.isScreenLocked);
    const current = workspaceVisibilityRef.current;
    if (current?.covered === covered && current.locked === locked
      && current.notificationSettings === notificationSettings) return current.result;
    const generation = ++workspaceGenerationRef.current;
    if (covered || locked) publishWorkspaceCoverage(true);
    async function synchronize() {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const bounds = !covered && !locked && desiredAppRef.current !== 'telegram'
          ? await measureNativeBounds() : undefined;
        if (!isMountedRef.current || generation !== workspaceGenerationRef.current) return false;
        const applied = await invoke<boolean>('multi_set_content_visible', {
          locked, generation, visible: !covered, bounds, notificationSettings,
        });
        if (!applied || !isMountedRef.current || generation !== workspaceGenerationRef.current) return false;
        if (!covered && !locked) publishWorkspaceCoverage(false);
        return true;
      } catch (error) {
        if (generation === workspaceGenerationRef.current) publishWorkspaceCoverage(true);
        handleError(new Error('Failed to synchronize workspace visibility', { cause: error }));
        return false;
      }
    }
    const result = synchronize();
    workspaceVisibilityRef.current = {
      covered, locked, notificationSettings, result,
    };
    void result.then((success) => {
      if (!success && workspaceVisibilityRef.current?.result === result) workspaceVisibilityRef.current = undefined;
    });
    return result;
  });

  useLayoutEffect(() => {
    document.documentElement.dataset.relayActiveApp = activeApp;
    window.dispatchEvent(new CustomEvent('egoist-relay-service-change', { detail: { app: activeApp } }));
  }, [activeApp]);

  useEffect(() => {
    if (!IS_TAURI) return;
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('multi_social_set_labels', {
      shareLabel: lang('RelayShareToTelegram'),
    })).catch(handleError);
  }, [lang]);

  useEffect(() => {
    if (!IS_TAURI) return undefined;
    let mounted = true;
    let release: NoneToVoidFunction | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<SocialShareRequest>(
      'multi-social-share', async ({ payload }) => {
        if (!mounted || !isSocialShareRequest(payload) || socialShareRef.current
          || payload.service !== desiredAppRef.current) return;
        socialShareRef.current = payload;
        const recovery = recoveryRequestRef.current;
        setShareRecovery(recovery && recovery.service === payload.service
          && recovery.sourceUrl === parseInlineSocialMediaUrl(payload.url)?.canonicalUrl ? recovery : undefined);
        recoveryRequestRef.current = undefined;
        setNotice(undefined);
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('multi_social_overlay', { requestId: payload.requestId, visible: true });
          if (mounted) setSocialShare(payload);
        } catch (err) {
          socialShareRef.current = undefined;
          setNotice(lang('RelayShareError'));
          handleError(new Error('Failed to open social share overlay', { cause: err }));
        }
      },
    )).then((unlisten) => {
      if (mounted) release = unlisten;
      else unlisten();
    }).catch(handleError);
    return () => {
      mounted = false;
      release?.();
    };
  }, [lang]);

  const handleCloseSocialShare = useLastCallback(async (
    requestId: string, wasSent?: boolean, success?: SocialShareSuccess, isQueued?: boolean,
  ) => {
    if (socialShareRef.current?.requestId !== requestId) return;
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('multi_social_cancel_media', { requestId });
    } catch (err) {
      handleError(new Error('Failed to cancel social media preparation', { cause: err }));
    }
    await invoke('multi_social_overlay', { requestId, visible: false });
    if (socialShareRef.current?.requestId === requestId) {
      socialShareRef.current = undefined;
      setSocialShare(undefined);
      setShareRecovery(undefined);
      if (isQueued) {
        setNotice(lang('RelayOperationQueuedNotice'));
        setIsOperationsOpen(true);
      }
      if (wasSent) {
        setNotice(success
          ? lang('RelayShareSentTo', { recipient: success.recipientName })
          : lang('RelayShareSent'));
      }
    }
  });

  useEffect(() => {
    if (!IS_TAURI) return undefined;
    let mounted = true;
    let release: NoneToVoidFunction | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ service?: 'x' }>(
      'multi-social-share-error', ({ payload }) => {
        if (!mounted || desiredAppRef.current === 'telegram'
          || (payload?.service && payload.service !== desiredAppRef.current)) return;
        setNotice(lang('RelayShareError'));
      },
    )).then((unlisten) => {
      if (mounted) release = unlisten;
      else unlisten();
    }).catch(handleError);
    return () => {
      mounted = false;
      release?.();
    };
  }, [lang]);

  useEffect(() => {
    if (IS_INSTALL_PROMPT_SUPPORTED) {
      setupBeforeInstallPrompt();
    }
  }, []);

  useEffect(() => {
    const hash = getInitialLocationHash();
    // If there is no stored session on first slot, navigate to any other slot with stored session
    if (!hasStoredSession() && !ACCOUNT_SLOT && !hash) {
      const firstLoggedInAccountSlot = getFirstLoggedInAccountSlot();
      if (firstLoggedInAccountSlot) {
        const url = getAccountSlotUrl(firstLoggedInAccountSlot);
        window.location.href = `${url}#${hash || 'login'}`;
      }
    }

    // TODO[Passcode]: Remove when multiacc passcode is implemented
    const checkMultiaccPasscode = async () => {
      if (checkSessionLocked() && ACCOUNT_SLOT && await hasEncryptedSession()) {
        const url = getAccountSlotUrl(1);
        window.location.href = url;
      }
    };
    void checkMultiaccPasscode().catch((err) => {
      handleError(new Error('Failed to read account lock state', { cause: err }));
    });
  }, []);

  // Prevent drop on elements that do not accept it
  useEffect(() => {
    const body = document.body;
    const isDropAllowedTarget = (target: HTMLElement | null) => {
      if (!target || !(target instanceof Element)) return false;
      return Boolean(
        target.dataset?.dropzone
        || target.closest?.('#MiddleColumn, .messages-layout, .MessageList, .Composer, .DropArea, [data-dropzone]'),
      );
    };

    const handleDrag = (e: DragEvent) => {
      e.preventDefault();
      if (!e.dataTransfer) return;
      const target = e.target as HTMLElement | null;
      if (!isDropAllowedTarget(target)) {
        const isFileHoverOpen = hasFiles(e.dataTransfer)
          && e.target instanceof Element
          && Boolean(e.target.closest(FILE_HOVER_OPEN_SELECTOR));
        e.dataTransfer.dropEffect = isFileHoverOpen ? 'link' : 'none';
      } else {
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const handleDrop = (e: DragEvent) => {
      const target = e.target as HTMLElement | null;
      if (!isDropAllowedTarget(target)) {
        e.preventDefault();
      }
    };
    body.addEventListener('drop', handleDrop);
    body.addEventListener('dragover', handleDrag);
    body.addEventListener('dragenter', handleDrag);

    return () => {
      body.removeEventListener('drop', handleDrop);
      body.removeEventListener('dragover', handleDrag);
      body.removeEventListener('dragenter', handleDrag);
    };
  }, []);

  // return <Test />;

  let activeKey: AppScreens;
  let page: UiLoaderPage | undefined;

  if (inactiveReason) {
    activeKey = AppScreens.inactive;
  } else if (isScreenLocked) {
    page = 'lock';
    activeKey = AppScreens.lock;
  } else if (authState) {
    switch (authState) {
      case 'authorizationStateWaitPhoneNumber':
        page = 'authPhoneNumber';
        activeKey = AppScreens.auth;
        break;
      case 'authorizationStateWaitCode':
        page = 'authCode';
        activeKey = AppScreens.auth;
        break;
      case 'authorizationStateWaitPassword':
        page = 'authPassword';
        activeKey = AppScreens.auth;
        break;
      case 'authorizationStateWaitRegistration':
        activeKey = AppScreens.auth;
        break;
      case 'authorizationStateWaitQrCode':
        page = 'authQrCode';
        activeKey = AppScreens.auth;
        break;
      case 'authorizationStateClosed':
      case 'authorizationStateClosing':
      case 'authorizationStateLoggingOut':
      case 'authorizationStateReady':
        page = 'main';
        activeKey = AppScreens.main;
        break;
    }
  } else if (hasStoredSession()) {
    page = 'main';
    activeKey = AppScreens.main;
  } else if (hasPasscode) {
    activeKey = AppScreens.lock;
  } else {
    page = isMobileOs ? 'authPhoneNumber' : 'authQrCode';
    activeKey = AppScreens.auth;
  }

  if (activeKey !== AppScreens.lock
    && activeKey !== AppScreens.inactive
    && activeKey !== AppScreens.main
    && parseInitialLocationHash()?.tgWebAuthToken
    && !hasWebAuthTokenFailed) {
    page = 'main';
    activeKey = AppScreens.main;
  }

  const canOpenTelegram = activeKey === AppScreens.main && authState === 'authorizationStateReady' && !isScreenLocked;
  const canOpenLibrary = IS_TAURI && canOpenTelegram;
  const canOpenPalette = !isScreenLocked && (activeKey === AppScreens.main
    || (IS_TAURI && activeKey === AppScreens.auth));

  const handleFocusRegion = useLastCallback((event: KeyboardEvent) => {
    if (event.key !== 'F6' || event.defaultPrevented || event.repeat || event.isComposing || event.altKey
      || event.ctrlKey || event.metaKey || isScreenLocked
      || document.body.classList.contains('has-open-dialog')) return;
    const regions = [
      { region: '[data-relay-sidebar]', target: 'button[aria-current="page"]' },
      { region: '[data-relay-caption]', target: 'button' },
      { region: `#relay-${activeApp}-pane:not([inert])` },
      { region: '#relay-media-operations', target: 'button' },
    ].flatMap(({ region, target }) => {
      const element = document.querySelector<HTMLElement>(region);
      const focus = target ? element?.querySelector<HTMLElement>(target) : element;
      return element && focus ? [{ element, focus }] : [];
    });
    if (!regions.length) return;
    const current = regions.findIndex(({ element }) => element.contains(document.activeElement));
    const offset = event.shiftKey ? regions.length - 1 : 1;
    const next = current < 0 ? (event.shiftKey ? regions.length - 1 : 0) : (current + offset) % regions.length;
    event.preventDefault();
    regions[next].focus.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!IS_TAURI) return undefined;
    document.addEventListener('keydown', handleFocusRegion);
    return () => document.removeEventListener('keydown', handleFocusRegion);
  }, [handleFocusRegion]);

  useEffect(() => {
    updateSizes();
  }, []);

  useEffect(() => {
    if (inactiveReason) {
      document.title = INACTIVE_PAGE_TITLE;
    } else if (activeApp === 'x') {
      document.title = `X — ${ACTIVE_PAGE_TITLE}`;
    } else if (activeApp === 'instagram') {
      document.title = `Instagram — ${ACTIVE_PAGE_TITLE}`;
    } else {
      document.title = ACTIVE_PAGE_TITLE;
    }
  }, [activeApp, inactiveReason]);

  useEffect(() => {
    if (!IS_TAURI) return undefined;
    const release = subscribeMediaOperations(() => setOperationsSnapshot(getMediaOperationsSnapshot()));
    return release;
  }, []);
  const hasJournalNotice = Boolean(operationsSnapshot.journalNotice);
  const wasJournalNoticeShownRef = useRef(false);
  useEffect(() => {
    if (!hasJournalNotice || wasJournalNoticeShownRef.current) return;
    wasJournalNoticeShownRef.current = true;
    setNotice(lang('RelayOperationJournalRecovered'));
  }, [hasJournalNotice, lang]);
  useEffect(() => {
    if (!IS_TAURI) return;
    void setMediaOperationsLocked(activeKey !== AppScreens.main);
  }, [activeKey]);

  const handleWorkspaceResize = useLastCallback(() => {
    requestMeasure(() => {
      const element = workspaceRef.current;
      if (!element) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setIsOperationsFull(element.getBoundingClientRect().width < 64 * rem);
    });
  });
  useResizeObserver(workspaceRef, handleWorkspaceResize);

  const handleCloseOperations = useLastCallback(() => {
    setIsOperationsOpen(false);
    requestAnimationFrame(() => {
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    });
  });
  const handleOpenOperations = useLastCallback(async (section?: 'saved') => {
    if (isScreenLocked || isOperationsOpen || socialShareRef.current || isCacheDialogVisible
      || isNoticeHistoryVisible) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (isOperationsFull && !await applyWorkspaceVisibility(true)) return;
    if (getGlobal().passcode?.isScreenLocked) return;
    setOperationsInitialSection(section);
    setIsOperationsOpen(true);
  });
  const handleToggleOperations = useLastCallback(() => {
    if (isScreenLocked || socialShareRef.current || document.body.classList.contains('has-open-dialog')) return;
    if (isOperationsOpen) {
      handleCloseOperations();
      return;
    }
    void handleOpenOperations();
  });
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.repeat
        || event.key.toLowerCase() !== 'j') return;
      event.preventDefault();
      event.stopPropagation();
      handleToggleOperations();
    };
    document.addEventListener('keydown', handleKey, true);
    let mounted = true;
    let release: NoneToVoidFunction | undefined;
    if (IS_TAURI) {
      void import('@tauri-apps/api/event').then(({ listen }) => listen('relay-media-toggle', () => {
        if (mounted) handleToggleOperations();
      })).then((unlisten) => {
        if (mounted) release = unlisten;
        else unlisten();
      });
    }
    return () => {
      mounted = false;
      release?.();
      document.removeEventListener('keydown', handleKey, true);
    };
  }, []);
  useLayoutEffect(() => {
    const portals = document.getElementById('portals');
    portals?.toggleAttribute('inert', Boolean(isScreenLocked));
    if (isScreenLocked) {
      portals?.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((dialog) => dialog.close());
    }
    return () => {
      portals?.removeAttribute('inert');
    };
  }, [isScreenLocked]);

  useLayoutEffect(() => {
    void applyWorkspaceVisibility(Boolean(isScreenLocked) || (isOperationsOpen && isOperationsFull)
      || isPaletteVisible || isCacheDialogVisible || isCacheDialogPreparing || areAppSettingsVisible
      || isTitlebarMenuCovering || isNoticeHistoryVisible || Boolean(socialShare));
  }, [
    applyWorkspaceVisibility, isScreenLocked, isOperationsOpen, isOperationsFull, isPaletteVisible,
    isCacheDialogVisible, isCacheDialogPreparing, areAppSettingsVisible, isTitlebarMenuCovering,
    isNoticeHistoryVisible, socialShare, notificationSettings,
  ]);

  const handleOpenCacheDialog = useLastCallback(async (trigger: HTMLButtonElement) => {
    if (isClearingCacheRef.current || isScreenLocked || socialShareRef.current
      || !isAppSettingsOpen || isCacheDialogPreparing || isCacheDialogVisible) return;
    const covered = applyWorkspaceVisibility(true);
    setIsCacheDialogPreparing(true);
    const applied = await covered;
    setIsCacheDialogPreparing(false);
    if (!applied || getGlobal().passcode?.isScreenLocked || !trigger.isConnected) return;
    cacheDialogOriginRef.current = trigger;
    setIsCacheDialogVisible(true);
    setIsCacheDialogOpen(true);
  });

  const handleCloseCacheDialog = useLastCallback(() => setIsCacheDialogOpen(false));
  const handleCacheDialogClosed = useLastCallback(() => setIsCacheDialogVisible(false));
  useLayoutEffect(() => {
    if (isCacheDialogVisible) return;
    const trigger = cacheDialogOriginRef.current;
    cacheDialogOriginRef.current = undefined;
    if (!socialShareRef.current && !isScreenLocked && trigger?.isConnected) {
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  }, [isCacheDialogVisible, isScreenLocked]);

  const handleClearCache = useLastCallback(async () => {
    if (isClearingCacheRef.current || !isCacheDialogOpen || isScreenLocked) return;
    isClearingCacheRef.current = true;
    setIsClearingCache(true);
    setIsCacheDialogOpen(false);
    const results = await Promise.allSettled([
      clearStoredMediaCache(),
      import('@tauri-apps/api/core').then(({ invoke }) => invoke<WebviewCacheReport>('relay_clear_webview_cache')),
    ]);
    isClearingCacheRef.current = false;
    if (!isMountedRef.current) return;
    setIsClearingCache(false);
    const [media, webviews] = results;
    const states = webviews.status === 'fulfilled' && webviews.value
      ? [webviews.value.telegram, webviews.value.x, webviews.value.instagram] : [];
    const isWebviewIncomplete = states.length !== 3
      || states.some((state) => state !== 'cleared' && state !== 'deferred');
    if (media.status === 'rejected' && !states.some((state) => state === 'cleared' || state === 'deferred')) {
      setNotice(lang('RelayCacheFailed'));
    } else if (media.status === 'rejected' || isWebviewIncomplete) {
      setNotice(lang('RelayCachePartial'));
    } else {
      setNotice(lang(states.includes('deferred') ? 'RelayCacheDeferred' : 'RelayCacheCleared'));
    }
  });

  const prevActiveKey = usePrevious(activeKey);

  function renderContent() {
    switch (activeKey) {
      case AppScreens.auth:
        return <Auth />;
      case AppScreens.main:
        return <Main isMobile={isMobile} />;
      case AppScreens.inactive:
        return <AppInactive inactiveReason={inactiveReason!} />;
      case AppScreens.lock:
        return undefined;
    }
  }

  useTauriDrag();
  useFileHoverOpen();

  useLayoutEffect(() => {
    document.body.classList.add(styles.bg);
  }, []);

  useLayoutEffect(() => {
    // Prefer the chosen wallpaper's base color, so the pre-render base matches the
    // actual wallpaper instead of flashing the built-in default first.
    document.body.style.setProperty(
      '--theme-background-color',
      customBackgroundColor || (theme === 'dark' ? DARK_THEME_BG_COLOR : LIGHT_THEME_BG_COLOR),
    );
  }, [theme, customBackgroundColor]);

  useLayoutEffect(() => {
    // Fall back to the theme default when the tint is unset (e.g. a photo wallpaper without a
    // thumbnail), so service chips don't keep the previous wallpaper's tint.
    document.body.style.setProperty(
      '--action-message-bg',
      actionMessageBg || getActionMessageBg(theme)!,
    );
  }, [actionMessageBg, theme]);

  const getIsInBackgroundLocal = getIsInBackground;
  useSignalEffect(() => {
    // Mutation forced to avoid RAF throttling in background
    forceMutation(() => {
      document.body.classList.toggle('in-background', getIsInBackgroundLocal());
    }, document.body, true);
  }, [getIsInBackgroundLocal]);

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    const requestId = appSwitchRequestRef.current;
    appSwitchQueueRef.current = appSwitchQueueRef.current.then(async () => {
      try {
        await activateNativeApp('telegram', requestId);
      } catch (err) {
        handleError(new Error('Failed to initialize Telegram view', { cause: err }));
      }
    });

    return () => {
      isMountedRef.current = false;
      stopSocialWarmupRef.current?.();
      stopSocialWarmupRef.current = undefined;
      nativeBoundsRequestRef.current += 1;
      appSwitchRequestRef.current += 1;
      navigationRequestRef.current += 1;
      nativeStatusListenersRef.current.forEach((release) => release());
      nativeStatusListenersRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!IS_TAURI || isScreenLocked || inactiveReason || areServicesPrewarmedRef.current) return;
    areServicesPrewarmedRef.current = true;
    void prepareNativeStatusListeners().then(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      if (!isMountedRef.current) return;
      stopSocialWarmupRef.current = startSocialWarmup({
        commands: PREWARM_COMMANDS,
        isEnabled: () => !getGlobal().passcode?.isScreenLocked
          && selectSharedSettings(getGlobal()).shouldWarmupVisibleSocialViews === true,
        isCommandEnabled: (command) => {
          const { shouldHideX: isXHidden, shouldHideInstagram: isInstagramHidden } = selectSharedSettings(getGlobal());
          return !buildHiddenApps(isXHidden, isInstagramHidden)
            .includes(PREWARM_COMMAND_APPS[command as keyof typeof PREWARM_COMMAND_APPS]);
        },
        isTelegramReady: () => getGlobal().connectionState === 'connectionStateReady' && Boolean(getGlobal().isSynced),
        subscribeState: (refresh) => {
          addCallback(refresh);
          return () => {
            removeCallback(refresh);
          };
        },
        run: (command) => invoke(command),
        onError: (err) => handleError(new Error('Failed to prewarm a social view', { cause: err })),
      });
    }).catch((err) => {
      areServicesPrewarmedRef.current = false;
      handleError(new Error('Failed to prepare social view observers', { cause: err }));
    });
  }, [isScreenLocked, inactiveReason]);

  useEffect(() => {
    if (!HAS_NOTICE_HISTORY || !hasWebNotifications || isScreenLocked || inactiveReason) return undefined;
    const commands = PREWARM_COMMANDS.filter((command) => !hiddenApps.includes(PREWARM_COMMAND_APPS[command]));
    if (!commands.length) return undefined;

    let isCancelled = false;
    async function prepareNotificationServices() {
      const { invoke } = await import('@tauri-apps/api/core');
      const synchronized = await workspaceVisibilityRef.current?.result;
      if (!synchronized) return;
      for (const command of commands) {
        if (isCancelled || !isMountedRef.current || getGlobal().passcode?.isScreenLocked) return;
        try {
          await invoke(command, { forNotifications: true });
        } catch (error) {
          handleError(new Error('Failed to start service notifications', { cause: error }));
        }
      }
    }
    const timer = window.setTimeout(() => {
      void prepareNotificationServices().catch(handleError);
    }, WARMUP_READY_DELAY_MS);
    return () => {
      isCancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasWebNotifications, hiddenApps, inactiveReason, isScreenLocked]);

  const handleNavigation = useLastCallback(async (action: SocialNavigationAction | 'login') => {
    if (!IS_TAURI || isScreenLocked || socialShareRef.current || activeApp === 'telegram'
      || desiredAppRef.current !== activeApp || isNavigatingRef.current) return;

    const app = activeApp;
    const requestId = appSwitchRequestRef.current;
    const navigationId = ++navigationRequestRef.current;
    const shouldActivate = app === 'x' ? xAppState === 'error' : instagramAppState === 'error';
    isNavigatingRef.current = true;
    setIsNavigating(true);
    if (app === 'x' && action !== 'browser-login') setXFailureDetails(undefined);

    appSwitchQueueRef.current = appSwitchQueueRef.current.then(async () => {
      try {
        if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
        if (shouldActivate && action !== 'browser-login') {
          await activateNativeApp(app, requestId);
          if (action === 'reload') return;
        }
        const { invoke } = await import('@tauri-apps/api/core');
        if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
        if (action === 'reload' || action === 'home' || action === 'login') {
          if (app === 'x') setXAppState('loading');
          else setInstagramAppState('loading');
        }
        await invoke(app === 'x' ? 'multi_x_navigate' : 'multi_instagram_navigate', { action });
      } catch (err) {
        if (isMountedRef.current && requestId === appSwitchRequestRef.current && desiredAppRef.current === app) {
          if (action === 'browser-login') setNotice(lang('RelayBrowserLoginFailed'));
          else if (app === 'x') setXAppState('error');
          else setInstagramAppState('error');
        }
        handleError(new Error(`Failed to navigate ${app}`, { cause: err }));
      } finally {
        if (isMountedRef.current && navigationId === navigationRequestRef.current) {
          isNavigatingRef.current = false;
          setIsNavigating(false);
        }
      }
    });
    await appSwitchQueueRef.current;
  });

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(undefined), NOTICE_DURATION);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    let isMounted = true;
    let unlistenDownload: NoneToVoidFunction | undefined;
    async function listenForDownloads() {
      const { listen } = await import('@tauri-apps/api/event');
      const releaseDownload = await listen<DownloadStatusPayload>('download-finished', ({ payload }) => {
        if (!isMounted) return;
        setNotice(lang(getDownloadNoticeKey(payload)));
      });
      if (!isMounted) releaseDownload();
      else unlistenDownload = releaseDownload;
    }
    void listenForDownloads().catch((err) => {
      handleError(new Error('Failed to listen for downloads', { cause: err }));
    });
    return () => {
      isMounted = false;
      unlistenDownload?.();
    };
  }, [lang]);

  const handleRetryX = useLastCallback(() => {
    void handleNavigation('reload');
  });

  const handleLogin = useLastCallback(() => {
    void handleNavigation('login');
  });

  const handleBrowserLogin = useLastCallback(() => {
    void handleNavigation('browser-login');
  });

  const handleRetryInstagram = useLastCallback(() => {
    void handleNavigation('reload');
  });

  const handleOpenSocialInBrowser = useLastCallback(async () => {
    if (!IS_TAURI || isScreenLocked || activeApp === 'telegram') return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (getGlobal().passcode?.isScreenLocked) return;
      await invoke('multi_open_external', { url: activeApp === 'x' ? 'https://x.com/' : 'https://www.instagram.com/' });
    } catch (error) {
      handleError(new Error('Failed to open the service in a browser', { cause: error }));
    }
  });
  const openAppSettings = useLastCallback(async (trigger: Element | null | undefined) => {
    if (socialShareRef.current || isScreenLocked) return;
    if (!await applyWorkspaceVisibility(true) || getGlobal().passcode?.isScreenLocked) return;
    settingsOriginRef.current = trigger instanceof HTMLElement ? trigger : undefined;
    setAreAppSettingsVisible(true);
    setIsAppSettingsOpen(true);
  });
  const handleOpenAppSettings = useLastCallback(() => openAppSettings(document.activeElement));

  const handleCloseAppSettings = useLastCallback(() => {
    setIsAppSettingsOpen(false);
  });
  const handleAppSettingsClosed = useLastCallback(() => {
    setAreAppSettingsVisible(false);
    const trigger = settingsOriginRef.current;
    settingsOriginRef.current = undefined;
    if (trigger?.isConnected && !getGlobal().passcode?.isScreenLocked) {
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  });

  const handleMenuVisibilityChange = useLastCallback(async (isOpen: boolean) => {
    if (isOpen && (!await applyWorkspaceVisibility(true) || getGlobal().passcode?.isScreenLocked)) return false;
    setIsTitlebarMenuCovering(isOpen);
    if (isOpen) return true;
    if (getGlobal().passcode?.isScreenLocked || isPaletteVisible || isCacheDialogVisible
      || isCacheDialogPreparing || areAppSettingsVisible || isNoticeHistoryVisible || socialShareRef.current
      || (isOperationsOpen && isOperationsFull)) return false;
    return applyWorkspaceVisibility(false);
  });

  useEffect(() => {
    if (isScreenLocked || socialShare) setIsCacheDialogOpen(false);
  }, [isScreenLocked, socialShare]);

  useEffect(() => {
    if (isScreenLocked) {
      setIsAppSettingsOpen(false);
      setAreAppSettingsVisible(false);
      setIsTitlebarMenuCovering(false);
      setIsCacheDialogPreparing(false);
      setIsCacheDialogVisible(false);
      setIsOperationsOpen(false);
      setIsPaletteVisible(false);
      setIsNoticeHistoryOpen(false);
      setIsNoticeHistoryVisible(false);
      settingsOriginRef.current = undefined;
      paletteOriginRef.current = undefined;
      noticeHistoryOriginRef.current = undefined;
    }
  }, [isScreenLocked]);

  const handleSelectApp = useLastCallback((app: AppId) => {
    if (isScreenLocked || socialShareRef.current || hiddenApps.includes(app)) return;
    if (isOperationsFull && isOperationsOpen) handleCloseOperations();

    if (app === desiredAppRef.current) {
      if (app === activeApp && app === 'x' && xAppState === 'error') void handleRetryX();
      if (app === activeApp && app === 'instagram' && instagramAppState === 'error') void handleRetryInstagram();
      return;
    }

    desiredAppRef.current = app;
    // Под нативным окном X или Instagram модалка не видна, но держала бы фокус и Esc
    if (app !== 'telegram') setIsAppSettingsOpen(false);
    const requestId = ++appSwitchRequestRef.current;
    nativeBoundsRequestRef.current += 1;
    lastNativeBoundsRef.current = undefined;
    navigationRequestRef.current += 1;
    isNavigatingRef.current = false;
    setIsNavigating(false);

    if (!IS_TAURI) {
      setActiveApp(app);
      if (app === 'x') setXAppState('error');
      if (app === 'instagram') setInstagramAppState('error');
      return;
    }

    appSwitchQueueRef.current = appSwitchQueueRef.current.then(async () => {
      if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;

      if (app === 'x') {
        setXFailureDetails(undefined);
        setXAppState((state) => (state === 'ready' || state === 'auth-required' ? state : 'loading'));
      }
      if (app === 'instagram') {
        setInstagramAppState((state) => (state === 'ready' || state === 'auth-required' ? state : 'loading'));
      }

      try {
        await activateNativeApp(app, requestId);
        if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
        setActiveApp(app);
      } catch (err) {
        if (isMountedRef.current && requestId === appSwitchRequestRef.current && desiredAppRef.current === app) {
          if (app !== 'telegram') {
            setActiveApp(app);
          } else {
            desiredAppRef.current = activeApp;
            setIsAppSettingsOpen(false);
          }
          if (app === 'x') setXAppState('error');
          if (app === 'instagram') setInstagramAppState('error');
          setNotice(lang('RelayAppSwitchError'));
        }
        handleError(new Error(`Failed to activate ${app}`, { cause: err }));
      }
    });
  });

  const handleOpenLagomNotice = useLastCallback((payload: {
    service: AppId;
    target?: { chatId?: string; messageId?: number };
  }) => {
    if (isScreenLocked || hiddenApps.includes(payload.service)) return;
    handleSelectApp(payload.service);
    const { chatId, messageId } = payload.target || {};
    if (payload.service === 'telegram' && chatId && messageId) {
      getActions().focusMessage({ chatId, messageId, shouldReplaceHistory: true });
    }
  });

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    let isDisposed = false;
    let unlisten: VoidFunction | undefined;
    async function subscribeToLagomNotices() {
      const { listen } = await import('@tauri-apps/api/event');
      if (isDisposed) return;
      const release = await listen<Parameters<typeof handleOpenLagomNotice>[0]>(
        'relay-lagom-notice-opened',
        ({ payload }) => handleOpenLagomNotice(payload),
      );
      if (isDisposed) release();
      else unlisten = release;
    }
    void subscribeToLagomNotices().catch((err) => handleError(err));
    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, [handleOpenLagomNotice]);

  // Если активный сервис скрыли в настройках, возвращаемся в Telegram
  useEffect(() => {
    if (hiddenApps.includes(activeApp)) handleSelectApp('telegram');
  }, [hiddenApps, activeApp]);

  useEffect(() => {
    if (!IS_TAURI) return undefined;

    if (!('__TAURI_INTERNALS__' in window)) return undefined;

    let isDisposed = false;
    let unlisten: VoidFunction | undefined;
    async function subscribeToTelegramLinks() {
      const [{ invoke }, { getCurrentWebview }] = await Promise.all([
        import('@tauri-apps/api/core'), import('@tauri-apps/api/webview'),
      ]);
      if (isDisposed) return;
      const webview = getCurrentWebview();
      if (webview.label !== 'main') return;

      async function takeLinks() {
        if (isDisposed) return;
        const links = normalizeNativeDeepLinks(await invoke('relay_take_deep_links'));
        if (!isDisposed && links.length) {
          setPendingTelegramLinks((pending) => [...pending, ...links].slice(-MAX_NATIVE_LINKS));
        }
      }

      const release = await webview.listen('relay-deep-links-pending', () => {
        void takeLinks().catch(handleError);
      });
      if (isDisposed) {
        release();
        return;
      }
      unlisten = release;
      await takeLinks();
    }

    void subscribeToTelegramLinks().catch(handleError);
    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingTelegramLinks.length || activeKey !== AppScreens.main || !isSynced
      || socialShare || isPaletteVisible || isCacheDialogVisible || isNoticeHistoryVisible
      || (isOperationsOpen && isOperationsFull)) return;

    if (activeApp !== 'telegram' || desiredAppRef.current !== 'telegram') {
      handleSelectApp('telegram');
      return;
    }

    setIsAppSettingsOpen(false);
    setPendingTelegramLinks((pending) => pending.slice(pendingTelegramLinks.length));
    for (const url of pendingTelegramLinks) {
      // Системная ссылка не имеет контекста сообщения или доверенной ссылки внутри Telegram
      getActions().openTelegramLink({ url });
    }
  }, [
    activeApp, activeKey, handleSelectApp, isOperationsFull, isOperationsOpen, isCacheDialogVisible,
    isPaletteVisible, isNoticeHistoryVisible, isSynced, pendingTelegramLinks, socialShare,
  ]);

  const handleOperationSource = useLastCallback(async (operation: MediaOperation) => {
    if (!operation.sourceUrl || isScreenLocked) return;
    handleCloseOperations();
    if (!await applyWorkspaceVisibility(false)) return;
    const { invoke } = await import('@tauri-apps/api/core');
    handleSelectApp(operation.service);
    await appSwitchQueueRef.current;
    if (operation.service === 'telegram') {
      getActions().openTelegramLink({ url: operation.sourceUrl });
    } else {
      await invoke('relay_media_operation_source', { id: operation.id });
    }
  });
  useEffect(() => {
    const handleRecapture = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id;
      const operation = getMediaOperationsSnapshot().operations.find((value) => value.id === id);
      if (!operation || operation.stage === 'uncertain') return;
      recoveryRequestRef.current = operation;
      void handleOperationSource(operation)
        .then(() => setNotice(lang('RelayOperationRecaptureHelp'))).catch((error) => {
          recoveryRequestRef.current = undefined;
          setNotice(lang('RelayOperationUnavailable'));
          handleError(error);
        });
    };
    window.addEventListener('relay-media-recapture', handleRecapture);
    return () => window.removeEventListener('relay-media-recapture', handleRecapture);
  }, [lang]);

  const handleOperationChat = useLastCallback(async (operation: MediaOperation) => {
    if (!operation.send || operation.send.accountId !== getGlobal().currentUserId) {
      throw new Error('MEDIA_ACCOUNT_CHANGED');
    }
    handleCloseOperations();
    handleSelectApp('telegram');
    await appSwitchQueueRef.current;
    getActions().openChat({ id: operation.send.peerId });
  });

  const handleClosePalette = useLastCallback(() => {
    setIsPaletteOpen(false);
  });

  const handlePaletteClosed = useLastCallback(() => {
    setIsPaletteVisible(false);
    const trigger = paletteOriginRef.current;
    paletteOriginRef.current = undefined;
    if (trigger?.isConnected && !getGlobal().passcode?.isScreenLocked) {
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  });

  const handleTogglePalette = useLastCallback(async () => {
    if (isPaletteOpen) {
      handleClosePalette();
      return;
    }
    if (!canOpenPalette || isPaletteVisible || socialShareRef.current || isAppSettingsOpen
      || document.body.classList.contains('has-open-dialog')) return;
    if (isOperationsOpen) handleCloseOperations();
    paletteOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!await applyWorkspaceVisibility(true) || getGlobal().passcode?.isScreenLocked) return;
    setIsPaletteVisible(true);
    setIsPaletteOpen(true);
  });

  useEffect(() => {
    if (!canOpenPalette) setIsPaletteOpen(false);
  }, [canOpenPalette]);

  // В основном окне Ctrl+K уступает выделению в поле ввода (там это ссылка); из X и Instagram
  // сочетание приходит событием оболочки
  const handlePaletteKeyboard = useLastCallback((event: KeyboardEvent) => {
    const isModifier = IS_MAC_OS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!canOpenPalette || !isModifier || event.altKey || event.shiftKey || event.repeat || event.isComposing
      || event.code !== 'KeyK' || isComposerHasSelection()) return;
    if (!isPaletteOpen && document.body.classList.contains('has-open-dialog')) return;
    event.preventDefault();
    event.stopPropagation();
    void handleTogglePalette();
  });
  useEffect(() => {
    document.addEventListener('keydown', handlePaletteKeyboard, true);
    let mounted = true;
    let release: NoneToVoidFunction | undefined;
    if (IS_TAURI) {
      void import('@tauri-apps/api/event').then(({ listen }) => listen('relay-palette-toggle', () => {
        if (mounted) void handleTogglePalette();
      })).then((unlisten) => {
        if (mounted) release = unlisten;
        else unlisten();
      }).catch(handleError);
    }
    return () => {
      mounted = false;
      release?.();
      document.removeEventListener('keydown', handlePaletteKeyboard, true);
    };
  }, [handlePaletteKeyboard, handleTogglePalette]);

  const handleCloseNoticeHistory = useLastCallback(() => setIsNoticeHistoryOpen(false));
  const handleNoticeHistoryClosed = useLastCallback(() => {
    setIsNoticeHistoryVisible(false);
    const trigger = noticeHistoryOriginRef.current;
    noticeHistoryOriginRef.current = undefined;
    if (trigger?.isConnected && !getGlobal().passcode?.isScreenLocked) {
      requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  });
  const handleSelectNoticeService = useLastCallback((service: AppId) => {
    if (isScreenLocked || hiddenApps.includes(service)) return;
    handleCloseNoticeHistory();
    handleSelectApp(service);
  });

  const handlePaletteRun = useLastCallback(async (payload: PalettePayload, isSecondary: boolean) => {
    if (!canOpenPalette || getGlobal().passcode?.isScreenLocked) return;
    const origin = paletteOriginRef.current;
    setIsPaletteOpen(false);
    try {
      switch (payload.type) {
        case 'app':
          handleSelectApp(payload.app);
          break;
        case 'operations':
          if (payload.section === 'saved' && !canOpenLibrary) return;
          paletteOriginRef.current = undefined;
          await handleOpenOperations(payload.section);
          if (origin?.isConnected) previousFocusRef.current = origin;
          break;
        case 'relaySettings':
          paletteOriginRef.current = undefined;
          await openAppSettings(origin);
          break;
        case 'noticeHistory':
          if (!HAS_NOTICE_HISTORY || !await applyWorkspaceVisibility(true)
            || getGlobal().passcode?.isScreenLocked) return;
          paletteOriginRef.current = undefined;
          noticeHistoryOriginRef.current = origin;
          setIsNoticeHistoryVisible(true);
          setIsNoticeHistoryOpen(true);
          break;
        case 'telegramSettings':
          if (!canOpenTelegram) return;
          paletteOriginRef.current = undefined;
          handleSelectApp('telegram');
          await appSwitchQueueRef.current;
          if (payload.screen !== undefined) getActions().openSettingsScreen({ screen: payload.screen });
          else getActions().openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
          break;
        case 'chat':
          if (!canOpenTelegram) return;
          paletteOriginRef.current = undefined;
          handleSelectApp('telegram');
          await appSwitchQueueRef.current;
          getActions().openChat({ id: payload.id });
          break;
        case 'telegramSearch':
          if (!canOpenTelegram) return;
          paletteOriginRef.current = undefined;
          handleSelectApp('telegram');
          await appSwitchQueueRef.current;
          getActions().openLeftColumnContent({ contentKey: LeftColumnContent.GlobalSearch });
          getActions().setGlobalSearchQuery({ query: payload.query });
          break;
        case 'libraryFile': {
          if (!canOpenLibrary) return;
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('relay_library_action', { id: payload.id, action: isSecondary ? 'reveal' : 'open' });
          break;
        }
        case 'libraryLink': {
          if (!canOpenLibrary) return;
          if (payload.service === 'telegram') {
            handleSelectApp('telegram');
            await appSwitchQueueRef.current;
            getActions().openTelegramLink({ url: payload.url });
          } else {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('multi_open_external', { url: payload.url });
          }
          break;
        }
      }
    } catch (error) {
      setNotice(lang('RelayOperationUnavailable'));
      handleError(new Error('Failed to run a palette action', { cause: error }));
    }
  });

  // Оболочка усыпляет скрытые сервисы и будит при показе; rail показывает это меткой сна
  useEffect(() => {
    if (!IS_TAURI) return undefined;
    let mounted = true;
    let release: NoneToVoidFunction | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ service?: string; sleeping?: boolean }>(
      'multi-service-sleep', ({ payload }) => {
        const service = payload?.service;
        if (!mounted || (service !== 'x' && service !== 'instagram' && service !== 'telegram')) return;
        setSleepingApps((current) => {
          const has = current.includes(service);
          if (payload.sleeping) return has ? current : [...current, service];
          return has ? current.filter((id) => id !== service) : current;
        });
      },
    )).then((unlisten) => {
      if (mounted) release = unlisten;
      else unlisten();
    }).catch(handleError);
    return () => {
      mounted = false;
      release?.();
    };
  }, []);

  const isWorkspaceCovered = isOperationsOpen && isOperationsFull;
  const activeHistory = activeApp === 'telegram' ? undefined : serviceHistory[activeApp];
  const isSocialReady = activeApp === 'x' ? xAppState === 'ready' : instagramAppState === 'ready';

  return (
    <div className={styles.multiRoot}>
      <div className={styles.workspaceLayers} inert={Boolean(isScreenLocked)} aria-hidden={Boolean(isScreenLocked)}>
        <AppSidebar
          activeApp={activeApp}
          xAppState={xAppState}
          instagramAppState={instagramAppState}
          sleepingApps={sleepingApps}
          hiddenApps={hiddenApps}
          onSelectApp={handleSelectApp}
          onOpenSettings={isScreenLocked ? undefined : handleOpenAppSettings}
        />

        <div
          ref={workspaceRef}
          className={buildClassName(styles.mainWorkspace,
            isOperationsOpen && !isOperationsFull && styles.workspaceWithOperations,
            isOperationsOpen && isOperationsFull && styles.workspaceFullOperations)}
        >
          <div
            ref={nativeViewportRef}
            className={buildClassName(styles.nativeViewport, IS_TAURI && !IS_MAC_OS && styles.withTitlebar)}
            aria-hidden="true"
          />
          <Titlebar
            activeApp={activeApp}
            canGoBack={isSocialReady && activeHistory?.canGoBack}
            canGoForward={isSocialReady && activeHistory?.canGoForward}
            isNavigating={isNavigating}
            notice={notice}
            isOperationsOpen={isOperationsOpen}
            isPaletteOpen={isPaletteOpen}
            operationCount={operationsSnapshot.operations.filter(isMediaOperationActive).length}
            onToggleOperations={handleToggleOperations}
            onTogglePalette={canOpenPalette ? handleTogglePalette : undefined}
            onMenuVisibilityChange={handleMenuVisibilityChange}
            isMenuAllowed={!isScreenLocked}
            onNavigate={handleNavigation}
          />

          <div
            id="relay-telegram-pane"
            tabIndex={-1}
            className={buildClassName(
              styles.telegramPane,
              IS_TAURI && !IS_MAC_OS && styles.withTitlebar,
              activeApp !== 'telegram' && styles.hidden,
            )}
            inert={activeApp !== 'telegram' || isWorkspaceCovered}
            aria-hidden={activeApp !== 'telegram' || isWorkspaceCovered}
          >
            <UiLoader page={page} isMobile={isMobile}>
              <Transition
                name="fade"
                activeKey={activeKey}
                shouldCleanup
                className={buildClassName(
                  'full-height',
                  (activeKey === AppScreens.auth || prevActiveKey === AppScreens.auth) && 'is-auth',
                )}
                renderCount={TRANSITION_RENDER_COUNT}
              >
                {renderContent}
              </Transition>
              {activeKey === AppScreens.auth && isTestServer && <div className="test-server-badge">Test server</div>}
              <Notifications />
            </UiLoader>
          </div>

          <div
            id="relay-x-pane"
            tabIndex={-1}
            className={buildClassName(
              styles.xPane,
              IS_TAURI && !IS_MAC_OS && styles.withTitlebar,
              activeApp !== 'x' && styles.hidden,
            )}
            inert={activeApp !== 'x' || isWorkspaceCovered}
            aria-hidden={activeApp !== 'x' || isWorkspaceCovered}
            aria-busy={xAppState === 'loading'}
          >
            <div className={styles.xContentArea}>
              {xAppState !== 'ready' && (
                <SocialServiceStatus
                  service="x"
                  state={xAppState}
                  failureDetails={xFailureDetails}
                  isNavigating={isNavigating}
                  onRetry={handleRetryX}
                  onOpenBrowser={handleOpenSocialInBrowser}
                  onLogin={handleLogin}
                  onBrowserLogin={handleBrowserLogin}
                />
              )}
            </div>
          </div>

          <div
            id="relay-instagram-pane"
            tabIndex={-1}
            className={buildClassName(
              styles.instagramPane,
              IS_TAURI && !IS_MAC_OS && styles.withTitlebar,
              activeApp !== 'instagram' && styles.hidden,
            )}
            inert={activeApp !== 'instagram' || isWorkspaceCovered}
            aria-hidden={activeApp !== 'instagram' || isWorkspaceCovered}
            aria-busy={instagramAppState === 'loading'}
          >
            <div className={styles.xContentArea}>
              {instagramAppState !== 'ready' && (
                <SocialServiceStatus
                  service="instagram"
                  state={instagramAppState}
                  isNavigating={isNavigating}
                  onRetry={handleRetryInstagram}
                  onOpenBrowser={handleOpenSocialInBrowser}
                  onLogin={handleLogin}
                  onBrowserLogin={handleBrowserLogin}
                />
              )}
            </div>
          </div>
          {isOperationsOpen && (
            <MediaOperationsPanel
              snapshot={operationsSnapshot}
              initialSection={operationsInitialSection}
              isFull={isOperationsFull}
              onClose={handleCloseOperations}
              onSource={handleOperationSource}
              onChat={handleOperationChat}
            />
          )}
        </div>
        {!isScreenLocked && socialShare && (
          <SocialShareModal
            key={socialShare.requestId}
            request={socialShare}
            recoverOperation={shareRecovery}
            canSend={activeKey === AppScreens.main}
            onClose={handleCloseSocialShare}
          />
        )}
        <RelayAppSettingsModal
          isOpen={isAppSettingsOpen && !isScreenLocked}
          isClearingCache={isClearingCache}
          onOpenCacheDialog={IS_TAURI ? handleOpenCacheDialog : undefined}
          onClose={handleCloseAppSettings}
          onCloseAnimationEnd={handleAppSettingsClosed}
        />
        {!isScreenLocked && isCacheDialogVisible && (
          <ConfirmDialog
            isOpen={isCacheDialogOpen}
            className={styles.cacheConfirm}
            title={lang('RelayCacheConfirm')}
            confirmLabel={lang('RelayCacheClear')}
            confirmIsDestructive
            confirmHandler={handleClearCache}
            onClose={handleCloseCacheDialog}
            onCloseAnimationEnd={handleCacheDialogClosed}
          >
            <p className={styles.cacheDescription} dir="auto">{lang('RelayCacheDescription')}</p>
          </ConfirmDialog>
        )}
        <CommandPalette
          isOpen={isPaletteOpen && !isScreenLocked}
          canOpenTelegram={canOpenTelegram}
          canOpenNoticeHistory={HAS_NOTICE_HISTORY}
          canOpenLibrary={canOpenLibrary}
          hiddenApps={hiddenApps}
          sleepingApps={sleepingApps}
          onClose={handleClosePalette}
          onCloseAnimationEnd={handlePaletteClosed}
          onRun={handlePaletteRun}
        />
        {HAS_NOTICE_HISTORY && (
          <NoticeHistoryModal
            isOpen={isNoticeHistoryOpen && !isScreenLocked}
            isLocked={Boolean(isScreenLocked)}
            hiddenServices={hiddenApps}
            onClose={handleCloseNoticeHistory}
            onCloseAnimationEnd={handleNoticeHistoryClosed}
            onSelectService={handleSelectNoticeService}
          />
        )}
      </div>
      {isScreenLocked && (
        <div className={styles.workspaceLock}>
          <LockScreen isLocked />
        </div>
      )}
    </div>
  );
};

function SocialServiceStatus({
  service,
  state,
  failureDetails,
  isNavigating,
  onRetry,
  onOpenBrowser,
  onLogin,
  onBrowserLogin,
}: {
  service: 'x' | 'instagram';
  state: Exclude<XAppState, 'ready'>;
  failureDetails?: XFailureDetails;
  isNavigating: boolean;
  onRetry: NoneToVoidFunction;
  onOpenBrowser: NoneToVoidFunction;
  onLogin: NoneToVoidFunction;
  onBrowserLogin: NoneToVoidFunction;
}) {
  const lang = useLang();
  const isX = service === 'x';
  const isLoading = state === 'idle' || state === 'loading';
  const isError = state === 'error';
  const isSignIn = state === 'auth-required';
  const titleId = 'relay-' + service + '-status-title';
  const browserHelpId = 'relay-' + service + '-browser-sign-in-help';

  let title;
  let message;
  if (isSignIn) {
    title = lang(isX ? 'RelayXDirectLoginTitle' : 'RelayInstagramDirectLoginTitle');
    message = lang(isX ? 'RelayXDirectLoginHelp' : 'RelayInstagramDirectLoginHelp');
  } else if (isError) {
    title = lang(isX ? 'RelayXErrorTitle' : 'RelayInstagramErrorTitle');
    if (!IS_TAURI) {
      message = lang(isX ? 'RelayXDesktopOnly' : 'RelayInstagramDesktopOnly');
    } else if (failureDetails?.reason === 'timeout') {
      message = lang('RelayXTimeoutErrorText');
    } else if (failureDetails?.reason === 'browser') {
      message = lang('RelayXBrowserErrorText');
    } else if (failureDetails?.reason === 'navigation') {
      message = lang('RelayXNavigationErrorText', { code: failureDetails.code });
    } else {
      message = lang(isX ? 'RelayXErrorText' : 'RelayInstagramErrorText');
    }
  } else {
    title = lang(isX ? 'RelayXLoadingTitle' : 'RelayInstagramLoadingTitle');
    message = lang(isX ? 'RelayXLoadingText' : 'RelayInstagramLoadingText');
  }

  return (
    <section className={styles.xStatus} aria-labelledby={titleId} data-relay-service-status={state}>
      <div className={styles.serviceIntro}>
        <div className={styles.serviceMark} aria-hidden="true">
          {isX ? (
            <svg viewBox="0 0 24 24" className={styles.serviceIcon} fill="currentColor" focusable="false">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              className={styles.serviceIcon}
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              focusable="false"
            >
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
              <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" stroke-width="2.5" />
            </svg>
          )}
        </div>
        <div className={styles.serviceCopy} role={isError ? 'alert' : 'status'}>
          <h1 id={titleId} className={styles.serviceTitle}>{title}</h1>
          <p className={styles.serviceText}>{message}</p>
          {isSignIn && isX && <p className={styles.serviceText}>{lang('RelayXPasswordHelp')}</p>}
          {isLoading && <span className={styles.serviceProgress} aria-hidden="true" />}
        </div>
      </div>
      {IS_TAURI && (isError || isSignIn) && (
        <div className={styles.serviceActions}>
          <button
            type="button"
            className={buildClassName(styles.serviceButton, styles.servicePrimary)}
            onClick={isSignIn ? onLogin : onRetry}
            disabled={isNavigating}
          >
            {isSignIn ? lang(isX ? 'RelayXDirectLogin' : 'RelayInstagramDirectLogin') : lang('RelayRetry')}
          </button>
          <button
            type="button"
            className={styles.serviceButton}
            onClick={isSignIn ? onBrowserLogin : onOpenBrowser}
            disabled={isNavigating}
            aria-describedby={isSignIn ? browserHelpId : undefined}
          >
            {lang(isSignIn ? 'RelayBrowserLogin' : 'RelayOpenServiceInBrowser')}
          </button>
          {isSignIn && (
            <p id={browserHelpId} className={buildClassName(styles.serviceText, styles.serviceActionHelp)}>
              {lang('RelayBrowserLoginHelp')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default withGlobal(
  (global): Complete<StateProps> => {
    const { state: authState, hasWebAuthTokenFailed, hasWebAuthTokenPasswordRequired } = global.auth;
    const theme = selectTheme(global);
    const themeValues = selectThemeValues(global, theme);
    const { hasWebNotifications, notificationSoundVolume } = selectSettingsKeys(global);

    return {
      authState,
      isSynced: global.isSynced,
      isScreenLocked: global.passcode?.isScreenLocked,
      hasPasscode: global.passcode?.hasPasscode,
      inactiveReason: selectTabState(global).inactiveReason,
      hasWebAuthTokenFailed: hasWebAuthTokenFailed || hasWebAuthTokenPasswordRequired,
      theme,
      customBackgroundColor: getWallpaperBaseColor(theme, themeValues || {}),
      isTestServer: global.config?.isTestServer,
      actionMessageBg: selectActionMessageBg(global),
      shouldHideX: selectSharedSettings(global).shouldHideX,
      shouldHideInstagram: selectSharedSettings(global).shouldHideInstagram,
      hasWebNotifications,
      notificationSoundVolume,
    };
  },
)(App);
