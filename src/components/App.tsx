import {
  useEffect, useLayoutEffect, useRef, useState,
} from '../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../global';

import type { GlobalState } from '../global/types';
import type { ThemeKey } from '../types';
import type { SocialNavigationAction } from './common/Titlebar';
import type { UiLoaderPage } from './common/UiLoader';
import type { AppId, InstagramAppState, XAppState } from './multi/AppSidebar';
import type { MediaOperation, MediaOperationsSnapshot } from './multi/mediaOperations.types';
import type { SocialShareRequest, SocialShareSuccess } from './multi/socialShare';

import {
  DARK_THEME_BG_COLOR, INACTIVE_MARKER, LIGHT_THEME_BG_COLOR, PAGE_TITLE, PAGE_TITLE_TAURI,
} from '../config';
import { requestMeasure } from '../lib/fasterdom/fasterdom';
import { forceMutation } from '../lib/fasterdom/stricterdom.ts';
import {
  selectActionMessageBg, selectTabState, selectTheme, selectThemeValues,
} from '../global/selectors';
import { selectSharedSettings } from '../global/selectors/sharedState';
import { IS_TAURI } from '../util/browser/globalEnvironment';
import { IS_INSTALL_PROMPT_SUPPORTED, IS_MAC_OS, PLATFORM_ENV } from '../util/browser/windowEnvironment';
import buildClassName from '../util/buildClassName';
import { handleError } from '../util/handleError';
import { parseInlineSocialMediaUrl } from '../util/inlineSocialMedia';
import { setupBeforeInstallPrompt } from '../util/installPrompt';
import { ACCOUNT_SLOT, getAccountSlotUrl, getFirstLoggedInAccountSlot } from '../util/multiaccount';
import { hasEncryptedSession } from '../util/passcode';
import { getInitialLocationHash, parseInitialLocationHash } from '../util/routing';
import { checkSessionLocked, hasStoredSession } from '../util/sessions';
import { resolveAppBounds } from '../util/tauri/appBounds';
import { getLastUserInputAt, startSocialWarmup } from '../util/tauri/socialWarmup';
import { getActionMessageBg, getWallpaperBaseColor } from '../util/wallpaper';
import { updateSizes } from '../util/windowSize';
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
import MediaOperationsPanel from './multi/MediaOperationsPanel';
import SocialShareModal from './multi/SocialShareModal';
// import Test from './test/demo/MessageTextStreamingTest';
import Transition from './ui/Transition';

import styles from './App.module.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
  isScreenLocked?: boolean;
  hasPasscode?: boolean;
  inactiveReason?: 'auth' | 'otherClient';
  hasWebAuthTokenFailed?: boolean;
  isTestServer?: boolean;
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
const PREWARM_COMMANDS = ['multi_prewarm_x', 'multi_prewarm_instagram'] as const;

type XStatusPayload = {
  state: Exclude<XAppState, 'idle'>;
  url?: string;
  message?: string;
};

type XFailureDetails = { reason: 'timeout' | 'browser' } | { reason: 'navigation'; code: number };

function parseXFailureDetails(message: unknown): XFailureDetails | undefined {
  if (message === 'The service did not become ready within 45 seconds') return { reason: 'timeout' };
  if (message === 'The service browser process stopped responding') return { reason: 'browser' };
  if (typeof message !== 'string') return undefined;

  const match = /^The service navigation failed: COREWEBVIEW2_WEB_ERROR_STATUS\((\d{1,2})\)$/.exec(message);
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

type DownloadStatusPayload = {
  success: boolean;
  service?: AppId;
  fileName?: string;
  error?: string;
};

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
  isScreenLocked,
  hasPasscode,
  inactiveReason,
  hasWebAuthTokenFailed,
  isTestServer,
  theme,
  customBackgroundColor,
  actionMessageBg,
}: StateProps) => {
  const { isMobile } = useAppLayout();
  const [activeApp, setActiveApp] = useState<AppId>('telegram');
  const [xAppState, setXAppState] = useState<XAppState>('idle');
  const [xFailureDetails, setXFailureDetails] = useState<XFailureDetails>();
  const [instagramAppState, setInstagramAppState] = useState<InstagramAppState>('idle');
  const [isNavigating, setIsNavigating] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [isOperationsOpen, setIsOperationsOpen] = useState(false);
  const [isOperationsFull, setIsOperationsFull] = useState(false);
  const [operationsSnapshot, setOperationsSnapshot] = useState<MediaOperationsSnapshot>(getMediaOperationsSnapshot);
  const workspaceRef = useRef<HTMLDivElement>();
  const previousFocusRef = useRef<HTMLElement>();
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
      if (!isMountedRef.current) releaseInstagram();
      else nativeStatusListenersRef.current.push(releaseInstagram);
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
    const bounds = await measureNativeBounds();
    const { invoke } = await import('@tauri-apps/api/core');
    if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
    await invoke('multi_set_active_app', { app, bounds });
  });

  const updateNativeBounds = useLastCallback(async () => {
    if (!IS_TAURI || desiredAppRef.current === 'telegram') return;
    const requestId = ++nativeBoundsRequestRef.current;
    try {
      const bounds = await measureNativeBounds();
      const { invoke } = await import('@tauri-apps/api/core');
      if (!isMountedRef.current || requestId !== nativeBoundsRequestRef.current) return;
      await invoke('multi_update_x_bounds', { bounds });
    } catch (error) {
      handleError(new Error('Failed to update service viewport', { cause: error }));
    }
  });
  useResizeObserver(nativeViewportRef, updateNativeBounds, !IS_TAURI);

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
  const handleToggleOperations = useLastCallback(() => {
    if (socialShareRef.current) return;
    if (isOperationsOpen) {
      handleCloseOperations();
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setIsOperationsOpen(true);
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
    if (!IS_TAURI) return;
    void import('@tauri-apps/api/core').then(async ({ invoke }) => {
      await invoke('multi_set_content_visible', { visible: !(isOperationsOpen && isOperationsFull) });
      await updateNativeBounds();
    }).catch(handleError);
  }, [isOperationsOpen, isOperationsFull]);

  const prevActiveKey = usePrevious(activeKey);

  function renderContent() {
    switch (activeKey) {
      case AppScreens.auth:
        return <Auth />;
      case AppScreens.main:
        return <Main isMobile={isMobile} />;
      case AppScreens.lock:
        return <LockScreen isLocked={isScreenLocked} />;
      case AppScreens.inactive:
        return <AppInactive inactiveReason={inactiveReason!} />;
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
        isEnabled: () => selectSharedSettings(getGlobal()).shouldWarmupSocialViews !== false,
        isTelegramReady: () => getGlobal().connectionState === 'connectionStateReady' && Boolean(getGlobal().isSynced),
        getLastInputAt: getLastUserInputAt,
        run: (command) => invoke(command),
        onError: (err) => handleError(new Error('Failed to prewarm a social view', { cause: err })),
      });
    }).catch((err) => {
      areServicesPrewarmedRef.current = false;
      handleError(new Error('Failed to prepare social view observers', { cause: err }));
    });
  }, [isScreenLocked, inactiveReason]);

  const handleNavigation = useLastCallback(async (action: SocialNavigationAction | 'login') => {
    if (!IS_TAURI || socialShareRef.current || activeApp === 'telegram'
      || desiredAppRef.current !== activeApp || isNavigatingRef.current) return;

    const app = activeApp;
    const requestId = appSwitchRequestRef.current;
    const navigationId = ++navigationRequestRef.current;
    const shouldActivate = app === 'x' ? xAppState === 'error' : instagramAppState === 'error';
    isNavigatingRef.current = true;
    setIsNavigating(true);
    if (app === 'x') setXFailureDetails(undefined);

    appSwitchQueueRef.current = appSwitchQueueRef.current.then(async () => {
      try {
        if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
        if (shouldActivate) {
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
          if (app === 'x') setXAppState('error');
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

  const handleLoginX = useLastCallback(() => {
    void handleNavigation('login');
  });

  const handleRetryInstagram = useLastCallback(() => {
    void handleNavigation('reload');
  });

  const handleSelectApp = useLastCallback((app: AppId) => {
    if (socialShareRef.current) return;
    if (isOperationsFull && isOperationsOpen) handleCloseOperations();

    if (app === desiredAppRef.current) {
      if (app === activeApp && app === 'x' && xAppState === 'error') void handleRetryX();
      if (app === activeApp && app === 'instagram' && instagramAppState === 'error') void handleRetryInstagram();
      return;
    }

    desiredAppRef.current = app;
    const requestId = ++appSwitchRequestRef.current;
    nativeBoundsRequestRef.current += 1;
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
      if (app === 'instagram') setInstagramAppState((state) => (state === 'ready' ? state : 'loading'));

      try {
        await activateNativeApp(app, requestId);
        if (!isMountedRef.current || requestId !== appSwitchRequestRef.current || desiredAppRef.current !== app) return;
        setActiveApp(app);
      } catch (err) {
        if (isMountedRef.current && requestId === appSwitchRequestRef.current && desiredAppRef.current === app) {
          if (app !== 'telegram') setActiveApp(app);
          else desiredAppRef.current = activeApp;
          if (app === 'x') setXAppState('error');
          if (app === 'instagram') setInstagramAppState('error');
          setNotice(lang('RelayAppSwitchError'));
        }
        handleError(new Error(`Failed to activate ${app}`, { cause: err }));
      }
    });
  });

  const handleOperationSource = useLastCallback(async (operation: MediaOperation) => {
    if (!operation.sourceUrl) return;
    handleCloseOperations();
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('multi_set_content_visible', { visible: true });
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

  const isWorkspaceCovered = isOperationsOpen && isOperationsFull;

  return (
    <div className={styles.multiRoot}>
      <AppSidebar
        activeApp={activeApp}
        xAppState={xAppState}
        instagramAppState={instagramAppState}
        onSelectApp={handleSelectApp}
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
          isXAuthRequired={xAppState === 'auth-required'}
          canNavigate={activeApp === 'x' ? xAppState === 'ready' : instagramAppState === 'ready'}
          isNavigating={isNavigating}
          notice={notice}
          isOperationsOpen={isOperationsOpen}
          operationCount={operationsSnapshot.operations.filter(isMediaOperationActive).length}
          onToggleOperations={handleToggleOperations}
          onLoginX={handleLoginX}
          onNavigate={handleNavigation}
        />

        <div
          id="relay-telegram-pane"
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
            {xAppState === 'auth-required' && (
              <div className={styles.xStatus} role="status" aria-live="polite">
                <h1 className={styles.xStatusTitle}>{lang('RelayXDirectLoginTitle')}</h1>
                <p className={styles.xStatusText}>{lang('RelayXDirectLoginHelp')}</p>
                <p className={styles.xStatusText}>{lang('RelayXPasswordHelp')}</p>
                <button type="button" className={styles.xRetryButton} onClick={handleLoginX}>
                  {lang('RelayXDirectLogin')}
                </button>
              </div>
            )}
            {(xAppState === 'idle' || xAppState === 'loading') && (
              <div className={styles.xStatus} role="status" aria-live="polite">
                <div className={styles.xStatusMark} aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    className={styles.xStatusIcon}
                    fill="currentColor"
                    focusable="false"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  <span className={styles.xSpinner} />
                </div>
                <h1 className={styles.xStatusTitle}>{lang('RelayXLoadingTitle')}</h1>
                <p className={styles.xStatusText}>{lang('RelayXLoadingText')}</p>
              </div>
            )}

            {xAppState === 'error' && (
              <div className={styles.xStatus} role="alert">
                <div className={buildClassName(styles.xStatusMark, styles.xStatusMarkError)} aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    className={styles.xStatusIcon}
                    fill="currentColor"
                    focusable="false"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                </div>
                <h1 className={styles.xStatusTitle}>{lang('RelayXErrorTitle')}</h1>
                <p className={styles.xStatusText}>
                  {!IS_TAURI ? lang('RelayXDesktopOnly')
                    : xFailureDetails?.reason === 'timeout' ? lang('RelayXTimeoutErrorText')
                      : xFailureDetails?.reason === 'browser' ? lang('RelayXBrowserErrorText')
                        : xFailureDetails?.reason === 'navigation'
                          ? lang('RelayXNavigationErrorText', { code: xFailureDetails.code })
                          : lang('RelayXErrorText')}
                </p>
                {IS_TAURI && (
                  <button type="button" className={styles.xRetryButton} onClick={handleRetryX}>
                    {lang('RelayRetry')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div
          id="relay-instagram-pane"
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
            {(instagramAppState === 'idle' || instagramAppState === 'loading') && (
              <div className={styles.xStatus} role="status" aria-live="polite">
                <div className={styles.xStatusMark} aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    className={styles.xStatusIcon}
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
                  <span className={styles.xSpinner} />
                </div>
                <h1 className={styles.xStatusTitle}>{lang('RelayInstagramLoadingTitle')}</h1>
                <p className={styles.xStatusText}>{lang('RelayInstagramLoadingText')}</p>
              </div>
            )}

            {instagramAppState === 'error' && (
              <div className={styles.xStatus} role="alert">
                <div className={buildClassName(styles.xStatusMark, styles.xStatusMarkError)} aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    className={styles.xStatusIcon}
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
                </div>
                <h1 className={styles.xStatusTitle}>{lang('RelayInstagramErrorTitle')}</h1>
                <p className={styles.xStatusText}>
                  {lang(IS_TAURI ? 'RelayInstagramErrorText' : 'RelayInstagramDesktopOnly')}
                </p>
                {IS_TAURI && (
                  <button type="button" className={styles.xRetryButton} onClick={handleRetryInstagram}>
                    {lang('RelayRetry')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {isOperationsOpen && (
          <MediaOperationsPanel
            snapshot={operationsSnapshot}
            isFull={isOperationsFull}
            onClose={handleCloseOperations}
            onSource={handleOperationSource}
            onChat={handleOperationChat}
          />
        )}
      </div>
      {socialShare && (
        <SocialShareModal
          key={socialShare.requestId}
          request={socialShare}
          recoverOperation={shareRecovery}
          canSend={activeKey === AppScreens.main}
          onClose={handleCloseSocialShare}
        />
      )}
    </div>
  );
};

export default withGlobal(
  (global): Complete<StateProps> => {
    const { state: authState, hasWebAuthTokenFailed, hasWebAuthTokenPasswordRequired } = global.auth;
    const theme = selectTheme(global);
    const themeValues = selectThemeValues(global, theme);

    return {
      authState,
      isScreenLocked: global.passcode?.isScreenLocked,
      hasPasscode: global.passcode?.hasPasscode,
      inactiveReason: selectTabState(global).inactiveReason,
      hasWebAuthTokenFailed: hasWebAuthTokenFailed || hasWebAuthTokenPasswordRequired,
      theme,
      customBackgroundColor: getWallpaperBaseColor(theme, themeValues || {}),
      isTestServer: global.config?.isTestServer,
      actionMessageBg: selectActionMessageBg(global),
    };
  },
)(App);
