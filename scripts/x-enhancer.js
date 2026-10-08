/** Egoist Relay presentation and media lifecycle for the X document */
(function () {
  'use strict';

  if (window.top !== window || !/^(.*\.)?(x|twitter)\.com$/i.test(window.location.hostname)) return;

  const STYLE_ID = 'egoist-x-typography-engine';
  const CSS_STYLES = `
    :root { --egoist-font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { font-family: var(--egoist-font-family) !important; -webkit-font-smoothing: antialiased; }
    [data-testid="tweetText"], [data-testid="User-Name"], [role="heading"], input, textarea, button {
      font-family: var(--egoist-font-family) !important;
    }
    ::-webkit-scrollbar { width: 0.5rem; height: 0.5rem; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #8888; border-radius: 0.5rem; }
    ::-webkit-scrollbar-thumb:hover { background: #888c; }
  `;
  const pausedVideos = new Set();
  const PHOTO_SELECTOR = '[data-testid="tweetPhoto"]';
  const PHOTO_STALL_MS = 20000;
  const PHOTO_RETRY_DELAYS = [1000, 3000, 8000];
  const MAX_PHOTO_STATES = 128;
  const photoStates = new Map();
  const photoBudgets = new Map();
  let photoObserver;
  let photoIntersectionObserver;
  let photoScanFrame;
  let photoLocation;
  let isAppActive = false;
  let isActive = false;

  function setActive(active) {
    isAppActive = active;
    updateVisibility();
  }

  function updateVisibility() {
    isActive = isAppActive && !document.hidden;
    photoStates.forEach(updatePhotoTimer);
    if (!isActive) {
      document.querySelectorAll('video').forEach((video) => {
        if (!video.paused && !video.ended) {
          pausedVideos.add(video);
          video.pause();
        }
      });
      return;
    }
    pausedVideos.forEach((video) => {
      const bounds = video.getBoundingClientRect();
      if (video.isConnected && bounds.bottom > 0 && bounds.top < window.innerHeight
        && bounds.right > 0 && bounds.left < window.innerWidth) {
        video.play().catch(() => {});
      }
    });
    pausedVideos.clear();
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS_STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  function initializeDocument() {
    injectStyles();
    startPhotoRecovery();
  }

  function startPhotoRecovery() {
    if (photoObserver || !document.body || typeof IntersectionObserver !== 'function') return;
    photoLocation = window.location.href;
    photoIntersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const state = photoStates.get(entry.target);
        if (!state) return;
        state.isIntersecting = entry.isIntersecting;
        updatePhotoTimer(state);
      });
    });
    photoObserver = new MutationObserver((records) => {
      if (records.some((record) => record.removedNodes.length)) {
        pausedVideos.forEach((video) => {
          if (!video.isConnected) pausedVideos.delete(video);
        });
      }
      if (records.some((record) => record.type === 'attributes'
        ? record.target.closest(PHOTO_SELECTOR)
        : record.removedNodes.length || Array.from(record.addedNodes).some((node) => node instanceof Element
          && (node.matches(PHOTO_SELECTOR) || node.querySelector(PHOTO_SELECTOR))))) {
        schedulePhotoScan();
      }
    });
    photoObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style', 'data-testid'],
    });
    window.addEventListener('popstate', schedulePhotoScan);
    window.addEventListener('hashchange', schedulePhotoScan);
    schedulePhotoScan();
  }

  function stopPhotoRecovery() {
    photoObserver?.disconnect();
    photoIntersectionObserver?.disconnect();
    photoObserver = undefined;
    photoIntersectionObserver = undefined;
    window.removeEventListener('popstate', schedulePhotoScan);
    window.removeEventListener('hashchange', schedulePhotoScan);
    if (photoScanFrame !== undefined) window.cancelAnimationFrame(photoScanFrame);
    photoScanFrame = undefined;
    photoStates.forEach(releasePhoto);
    photoBudgets.clear();
  }

  function schedulePhotoScan() {
    if (!photoObserver || photoScanFrame !== undefined) return;
    photoScanFrame = window.requestAnimationFrame(scanPhotos);
  }

  function scanPhotos() {
    photoScanFrame = undefined;
    if (photoLocation !== window.location.href) {
      photoStates.forEach(releasePhoto);
      photoBudgets.clear();
      photoLocation = window.location.href;
    }
    photoStates.forEach((state) => {
      const source = readPhotoSource(state.image);
      if (!source || source.key !== state.key) {
        releasePhoto(state);
      } else if (source.url !== state.expectedSrc) {
        clearPhotoTimer(state);
        state.expectedSrc = source.url;
        state.generation += 1;
        state.isDecoded = false;
        state.isDecoding = false;
        state.hasFailedDecode = false;
      }
    });
    document.querySelectorAll(`${PHOTO_SELECTOR} img`).forEach((image) => {
      if (photoStates.has(image) || photoStates.size >= MAX_PHOTO_STATES) return;
      const source = readPhotoSource(image);
      if (!source) return;
      const state = {
        image, key: source.key, firstSrc: source.url, alternateSrc: source.alternate,
        expectedSrc: source.url, generation: 0, isIntersecting: false, isDecoded: false, isDecoding: false,
        hasFailedDecode: false,
      };
      state.onLoad = () => {
        if (!canUsePhoto(state) || !image.complete || image.currentSrc !== state.expectedSrc) return;
        state.hasFailedDecode = false;
        decodePhoto(state);
      };
      state.onError = () => {
        if (!canUsePhoto(state) || !image.complete || image.currentSrc !== state.expectedSrc) return;
        state.generation += 1;
        state.isDecoded = false;
        state.isDecoding = false;
        schedulePhotoRetry(state);
      };
      image.addEventListener('load', state.onLoad);
      image.addEventListener('error', state.onError);
      photoStates.set(image, state);
      photoIntersectionObserver.observe(image);
    });
    photoStates.forEach(updatePhotoTimer);
  }

  function readPhotoSource(image) {
    if (!image.isConnected || !image.closest(PHOTO_SELECTOR)
      || image.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"], picture')
      || image.hasAttribute('srcset')) return undefined;
    const url = image.getAttribute('src') || '';
    const match = /^https:\/\/pbs\.twimg\.com\/media\/[\w-]{1,160}\?((?:format=(?:jpg|png|webp)&name=(?:thumb|small|medium|large|orig|\d{1,4}x\d{1,4}))|(?:name=(?:thumb|small|medium|large|orig|\d{1,4}x\d{1,4})&format=(?:jpg|png|webp)))$/.exec(url);
    if (!match) return undefined;
    const query = match[1].split('&');
    return { url, alternate: url.slice(0, url.indexOf('?') + 1) + query.slice().reverse().join('&'),
      key: url.slice(0, url.indexOf('?') + 1) + query.sort().join('&') };
  }

  function canUsePhoto(state) {
    const source = readPhotoSource(state.image);
    return photoStates.get(state.image) === state && source?.key === state.key
      && source.url === state.expectedSrc && photoLocation === window.location.href;
  }

  function canRecoverPhoto(state) {
    if (!canUsePhoto(state) || !isActive || !state.isIntersecting) return false;
    const bounds = state.image.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight
      && bounds.right > 0 && bounds.left < window.innerWidth
      && getComputedStyle(state.image).visibility === 'visible';
  }

  function updatePhotoTimer(state) {
    if (!canUsePhoto(state)) {
      pausePhotoTimer(state);
      return;
    }
    if (!canRecoverPhoto(state)) {
      pausePhotoTimer(state);
      return;
    }
    if (state.isDecoded || (photoBudgets.get(state.key) || 0) >= PHOTO_RETRY_DELAYS.length) {
      clearPhotoTimer(state);
      return;
    }
    if (state.timer !== undefined) return;
    if (state.image.complete && state.image.naturalWidth > 0 && state.image.currentSrc === state.expectedSrc
      && !state.isDecoding && !state.hasFailedDecode) {
      decodePhoto(state);
      return;
    }
    if (!state.phase) {
      state.phase = state.hasFailedDecode || (state.image.complete && !state.image.naturalWidth) ? 'retry' : 'stall';
      state.remaining = state.phase === 'retry'
        ? PHOTO_RETRY_DELAYS[photoBudgets.get(state.key) || 0] : PHOTO_STALL_MS;
    }
    state.dueAt = performance.now() + state.remaining;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const phase = state.phase;
      state.phase = undefined;
      state.remaining = undefined;
      if (!canRecoverPhoto(state)) return;
      if (phase === 'retry') retryPhoto(state);
      else if (!state.isDecoding && !state.hasFailedDecode && state.image.complete && state.image.naturalWidth > 0
        && state.image.currentSrc === state.expectedSrc) decodePhoto(state);
      else schedulePhotoRetry(state);
    }, state.remaining);
  }

  function decodePhoto(state) {
    if (!canUsePhoto(state) || state.isDecoding || state.isDecoded || state.hasFailedDecode || !state.image.complete
      || !state.image.naturalWidth || state.image.currentSrc !== state.expectedSrc) return;
    state.isDecoding = true;
    const generation = state.generation;
    state.image.decode().then(() => {
      if (!canUsePhoto(state) || generation !== state.generation) return;
      state.isDecoding = false;
      state.isDecoded = true;
      clearPhotoTimer(state);
    }, () => {
      if (!canUsePhoto(state) || generation !== state.generation) return;
      state.isDecoding = false;
      state.hasFailedDecode = true;
      schedulePhotoRetry(state);
    });
    updatePhotoTimer(state);
  }

  function schedulePhotoRetry(state) {
    if (state.phase !== 'retry') {
      clearPhotoTimer(state);
      state.phase = 'retry';
      state.remaining = PHOTO_RETRY_DELAYS[photoBudgets.get(state.key) || 0];
    }
    updatePhotoTimer(state);
  }

  function retryPhoto(state) {
    if (!canRecoverPhoto(state)) return;
    const attempts = photoBudgets.get(state.key) || 0;
    if (attempts >= PHOTO_RETRY_DELAYS.length
      || (!photoBudgets.has(state.key) && photoBudgets.size >= MAX_PHOTO_STATES)) return;
    // X paints the raster in a sibling while its accessible image has zero opacity
    const rasters = Array.from(state.image.parentElement.children).filter((element) => element.tagName === 'DIV'
      && getComputedStyle(element).backgroundImage === `url("${state.expectedSrc}")`);
    if (rasters.length > 1 || (!rasters.length && getComputedStyle(state.image).opacity === '0')) return;
    const source = state.expectedSrc === state.alternateSrc ? state.firstSrc : state.alternateSrc;
    photoBudgets.set(state.key, attempts + 1);
    state.generation += 1;
    state.isDecoded = false;
    state.isDecoding = false;
    state.hasFailedDecode = false;
    state.expectedSrc = source;
    // Parameter order creates a distinct image request without changing format, size or media identity
    state.image.src = source;
    rasters.forEach((element) => { element.style.backgroundImage = `url("${source}")`; });
    state.phase = 'stall';
    state.remaining = PHOTO_STALL_MS;
    updatePhotoTimer(state);
  }

  function pausePhotoTimer(state) {
    if (state.timer === undefined) return;
    state.remaining = Math.max(0, state.dueAt - performance.now());
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  function clearPhotoTimer(state) {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    state.phase = undefined;
    state.remaining = undefined;
  }

  function releasePhoto(state) {
    clearPhotoTimer(state);
    state.image.removeEventListener('load', state.onLoad);
    state.image.removeEventListener('error', state.onError);
    photoIntersectionObserver?.unobserve(state.image);
    photoStates.delete(state.image);
  }

  window.__egoistRelaySetActive = setActive;
  document.addEventListener('visibilitychange', updateVisibility);
  document.addEventListener('play', (event) => {
    if (!isActive && event.target instanceof HTMLVideoElement) {
      pausedVideos.add(event.target);
      event.target.pause();
    }
  }, true);
  window.addEventListener('pagehide', stopPhotoRecovery);
  window.addEventListener('pageshow', startPhotoRecovery);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeDocument, { once: true });
  } else {
    initializeDocument();
  }
})();
