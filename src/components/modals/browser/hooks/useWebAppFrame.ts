import type { ElementRef } from '../../../../lib/teact/teact';
import { useCallback, useEffect, useRef } from '../../../../lib/teact/teact';
import { getActions, getGlobal } from '../../../../global';

import type { WebApp, WebAppInboundEvent, WebAppOutboundEvent } from '../../../../types/webapp';
import type { NativeWebAppFrame } from '../../../../util/tauri/botWebApps';

import { getWebAppKey } from '../../../../global/helpers';
import { isMessageFromIframe } from '../../../../util/browser/iframe';
import { isValidProtocol } from '../../../../util/browser/url';
import { createNativeWebAppFrame, shouldUseNativeWebApp } from '../../../../util/tauri/botWebApps';
import { extractCurrentThemeParams } from '../../../../util/themeStyle';
import { REM } from '../../../common/helpers/mediaDimensions';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';
import useWindowSize from '../../../../hooks/window/useWindowSize';

const SCROLLBAR_STYLE = `* {
  scrollbar-width: thin;
  scrollbar-color: %SCROLLBAR_COLOR% transparent;
}

*::-webkit-scrollbar {
  width: 6px;
  height: 6px;
  background-color: transparent;
}

*::-webkit-scrollbar-thumb {
  border-radius: 6px;
  background-color: %SCROLLBAR_COLOR%;
}

*::-webkit-scrollbar-corner {
  background-color: transparent;
}`;

const RELOAD_TIMEOUT = 500;
const FULLSCREEN_BUTTONS_AREA_HEIGHT = 3.675 * REM;

const useWebAppFrame = (
  ref: ElementRef<HTMLIFrameElement>,
  isOpen: boolean,
  isFullscreen: boolean,
  isSimpleView: boolean,
  onEvent: (event: WebAppInboundEvent) => void,
  webApp?: WebApp,
  onLoad?: () => void,
  isNativeVisible = isOpen,
) => {
  const {
    showNotification,
    setWebAppPaymentSlug,
    openInvoice,
    closeBrowserTab,
    closeBrowserModal,
    openSuggestedStatusModal,
    updateWebApp,
    openUrl,
    changeBrowserModalState,
  } = getActions();

  const lang = useLang();
  const isNative = shouldUseNativeWebApp(webApp?.url);
  const nativeFrameRef = useRef<NativeWebAppFrame>();
  const pendingNativeEventsRef = useRef<WebAppOutboundEvent[]>([]);
  const isReloadSupportedRef = useRef<boolean>(false);
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const ignoreEventsRef = useRef<boolean>(false);
  const lastFrameSizeRef = useRef<{ width: number; height: number; isResizing?: boolean }>();
  const windowSize = useWindowSize();
  const isSameOrigin = webApp?.isSameOrigin;
  const webAppOrigin = isSameOrigin ? getWebAppOrigin(webApp.url) : undefined;

  useEffect(() => {
    if (!ref.current || !isOpen || isNative) return undefined;

    const handleLoad = () => {
      onLoad?.();
    };

    const frame = ref.current;
    frame.addEventListener('load', handleLoad);
    return () => {
      frame.removeEventListener('load', handleLoad);
    };
  }, [onLoad, ref, isOpen, isNative]);

  const sendEvent = useCallback((event: WebAppOutboundEvent) => {
    if (isNative) {
      if (nativeFrameRef.current) nativeFrameRef.current.sendEvent(event);
      else if (pendingNativeEventsRef.current.length < 64) pendingNativeEventsRef.current.push(event);
      return;
    }
    if (!ref.current?.contentWindow || (isSameOrigin && !webAppOrigin)) return;
    ref.current.contentWindow.postMessage(JSON.stringify(event), webAppOrigin || '*');
  }, [isSameOrigin, ref, webAppOrigin, isNative]);

  const sendFullScreenChanged = useCallback((value: boolean) => {
    sendEvent({
      eventType: 'fullscreen_changed',
      eventData: {
        is_fullscreen: value,
      },
    });
  }, [sendEvent]);

  const forceReloadFrame = useLastCallback((url: string) => {
    if (!ref.current) return;
    const frame = ref.current;
    frame.src = 'about:blank';
    frame.addEventListener('load', () => {
      frame.src = url;
    }, { once: true });
  });

  const reloadFrame = useCallback((url: string) => {
    if (isNative) {
      nativeFrameRef.current?.reload(url);
      return;
    }
    if (isReloadSupportedRef.current) {
      sendEvent({
        eventType: 'reload_iframe',
      });
      reloadTimeoutRef.current = setTimeout(() => {
        forceReloadFrame(url);
      }, RELOAD_TIMEOUT);
      return;
    }

    forceReloadFrame(url);
  }, [sendEvent, isNative]);

  const sendViewport = useCallback((isNonStable?: boolean) => {
    if (!ref.current) {
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    sendEvent({
      eventType: 'viewport_changed',
      eventData: {
        width,
        height,
        is_expanded: true,
        is_state_stable: !isNonStable,
      },
    });
  }, [sendEvent, ref]);

  const sendSafeArea = useCallback(() => {
    if (!ref.current) {
      return;
    }
    sendEvent({
      eventType: 'safe_area_changed',
      eventData: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
      },
    });

    sendEvent({
      eventType: 'content_safe_area_changed',
      eventData: {
        left: 0,
        right: 0,
        top: isFullscreen ? FULLSCREEN_BUTTONS_AREA_HEIGHT : 0,
        bottom: 0,
      },
    });
  }, [sendEvent, isFullscreen, ref]);

  const sendTheme = useCallback(() => {
    sendEvent({
      eventType: 'theme_changed',
      eventData: {
        theme_params: extractCurrentThemeParams(),
      },
    });
  }, [sendEvent]);

  const sendCustomStyle = useCallback((style: string) => {
    sendEvent({
      eventType: 'set_custom_style',
      eventData: style,
    });
  }, [sendEvent]);

  const handleData = useCallback((value: string) => {
    if (ignoreEventsRef.current) {
      return;
    }

    try {
      const data = JSON.parse(value) as WebAppInboundEvent;
      const { eventType, eventData } = data;
      // Handle some app requests here to simplify hook usage
      if (eventType === 'web_app_ready') {
        onLoad?.();
      }

      if (eventType === 'web_app_close') {
        if (webApp) {
          const key = getWebAppKey(webApp);
          closeBrowserTab({ key, skipClosingConfirmation: true });
        }
      }

      if (eventType === 'web_app_request_viewport') {
        sendViewport(windowSize.isResizing);
      }

      if (eventType === 'web_app_request_safe_area') {
        sendSafeArea();
      }

      if (eventType === 'web_app_request_content_safe_area') {
        sendSafeArea();
      }

      if (eventType === 'web_app_request_theme') {
        sendTheme();
      }

      if (eventType === 'iframe_ready') {
        const scrollbarColor = getComputedStyle(document.body).getPropertyValue('--color-scrollbar');
        sendCustomStyle(SCROLLBAR_STYLE.replace(/%SCROLLBAR_COLOR%/g, scrollbarColor));
        isReloadSupportedRef.current = Boolean(eventData.reload_supported);
      }

      if (eventType === 'iframe_will_reload') {
        clearTimeout(reloadTimeoutRef.current);
      }

      if (eventType === 'web_app_data_send') {
        if (!isSimpleView) return; // Allowed only in simple view
        ignoreEventsRef.current = true;
      }

      if (eventType === 'web_app_open_scan_qr_popup') {
        showNotification({
          message: 'Scanning QR code is not supported in this client yet',
        });
      }

      if (eventType === 'web_app_open_invoice') {
        if (!webApp) return;

        const key = getWebAppKey(webApp);
        setWebAppPaymentSlug({
          key,
          slug: eventData.slug,
        });
        openInvoice({
          type: 'slug',
          slug: eventData.slug,
        });
      }

      if (eventType === 'web_app_open_link') {
        if (!isValidProtocol(eventData.url, getGlobal().appConfig.webAppAllowedProtocols)) {
          return;
        }

        openUrl({ url: eventData.url, tryInstant: eventData.try_instant_view, shouldSkipModal: true });
      }

      if (eventType === 'web_app_biometry_get_info') {
        sendEvent({
          eventType: 'biometry_info_received',
          eventData: {
            available: false,
          },
        });
      }

      if (eventType === 'web_app_device_storage_clear'
        || eventType === 'web_app_device_storage_get_key'
        || eventType === 'web_app_device_storage_save_key') {
        const { req_id } = eventData;
        sendEvent({
          eventType: 'device_storage_failed',
          eventData: {
            req_id,
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_secure_storage_clear'
        || eventType === 'web_app_secure_storage_get_key'
        || eventType === 'web_app_secure_storage_restore_key'
        || eventType === 'web_app_secure_storage_save_key') {
        const { req_id } = eventData;
        sendEvent({
          eventType: 'secure_storage_failed',
          eventData: {
            req_id,
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_start_accelerometer') {
        sendEvent({
          eventType: 'accelerometer_failed',
          eventData: {
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_start_gyroscope') {
        sendEvent({
          eventType: 'gyroscope_failed',
          eventData: {
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_start_device_orientation') {
        sendEvent({
          eventType: 'device_orientation_failed',
          eventData: {
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_add_to_home_screen') {
        sendEvent({
          eventType: 'home_screen_failed',
          eventData: {
            error: 'UNSUPPORTED',
          },
        });
      }

      if (eventType === 'web_app_check_home_screen') {
        sendEvent({
          eventType: 'home_screen_checked',
          eventData: {
            status: 'unsupported',
          },
        });
      }

      if (eventType === 'web_app_set_emoji_status') {
        const { custom_emoji_id, duration } = eventData;

        if (!custom_emoji_id || typeof custom_emoji_id !== 'string') {
          sendEvent({
            eventType: 'emoji_status_failed',
            eventData: {
              error: 'SUGGESTED_EMOJI_INVALID',
            },
          });
          return;
        }

        if (duration) {
          try {
            BigInt(duration);
          } catch (e) {
            sendEvent({
              eventType: 'emoji_status_failed',
              eventData: {
                error: 'DURATION_INVALID',
              },
            });
            return;
          }
        }

        if (!webApp) {
          sendEvent({
            eventType: 'emoji_status_failed',
            eventData: {
              error: 'UNKNOWN_ERROR',
            },
          });
          return;
        }

        openSuggestedStatusModal({
          webAppKey: getWebAppKey(webApp),
          customEmojiId: custom_emoji_id,
          duration: Number(duration),
          botId: webApp.botId,
        });
      }

      onEvent(data);
    } catch (err) {
      // Ignore other messages
    }
  }, [
    isSimpleView, sendEvent, onEvent, sendCustomStyle, webApp,
    sendTheme, sendViewport, sendSafeArea, onLoad, windowSize.isResizing,
  ]);

  const handleMessage = useCallback((event: MessageEvent<string>) => {
    if (isNative || (isSameOrigin && !webAppOrigin) || !isMessageFromIframe(event, ref.current, webAppOrigin)) return;
    handleData(event.data);
  }, [isNative, isSameOrigin, webAppOrigin, ref, handleData]);

  const handleNativeData = useLastCallback(handleData);
  const handleNativeLoad = useLastCallback(() => onLoad?.());
  const getNativeVisible = useLastCallback(() => isNativeVisible);
  const handleNativeError = useLastCallback(() => {
    onLoad?.();
    showNotification({ message: lang('RelayMiniAppLoadFailed') });
  });
  const handleNativeEscape = useLastCallback(() => {
    closeBrowserModal();
  });
  const handleNativeDownloads = useLastCallback(() => changeBrowserModalState({ state: 'minimized' }));

  useEffect(() => {
    if (!isNative || !ref.current || !webApp?.url) return undefined;
    const native = createNativeWebAppFrame(ref.current, webApp.url, {
      isVisible: getNativeVisible, onMessage: handleNativeData, onLoad: handleNativeLoad,
      onError: handleNativeError, onEscape: handleNativeEscape, onDownloads: handleNativeDownloads,
    });
    nativeFrameRef.current = native;
    const pending = pendingNativeEventsRef.current;
    pending.splice(0).forEach(native.sendEvent);
    return () => {
      nativeFrameRef.current = undefined;
      pending.splice(0);
      clearTimeout(reloadTimeoutRef.current);
      native.dispose();
    };
  }, [isNative, ref, webApp?.url, getNativeVisible, handleNativeData, handleNativeLoad,
    handleNativeError, handleNativeEscape, handleNativeDownloads]);

  useEffect(() => {
    nativeFrameRef.current?.update();
  }, [isNativeVisible]);

  useEffect(() => {
    const { width, height, isResizing } = windowSize;
    if (lastFrameSizeRef.current && lastFrameSizeRef.current.width === width
      && lastFrameSizeRef.current.height === height && !lastFrameSizeRef.current.isResizing) return;
    lastFrameSizeRef.current = { width, height, isResizing };
    sendViewport(isResizing);
  }, [sendViewport, sendSafeArea, windowSize]);

  useEffect(() => {
    if (!webApp?.plannedEvents?.length) return;
    const events = webApp.plannedEvents;
    events.forEach((event) => {
      sendEvent(event);
    });

    updateWebApp({
      key: getWebAppKey(webApp),
      update: {
        plannedEvents: [],
      },
    });
  }, [sendEvent, webApp]);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage, ref]);

  useEffect(() => {
    if (isOpen && ref.current?.contentWindow) {
      sendViewport();
      sendSafeArea();
      ignoreEventsRef.current = false;
    } else {
      lastFrameSizeRef.current = undefined;
    }
  }, [isOpen, isFullscreen, sendViewport, sendSafeArea, ref]);

  return {
    sendEvent, sendFullScreenChanged, reloadFrame, sendViewport, sendSafeArea, sendTheme,
  };
};

function getWebAppOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return undefined;
  }
}

export default useWebAppFrame;
