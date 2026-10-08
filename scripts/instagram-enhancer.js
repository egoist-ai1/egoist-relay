/** Egoist Relay presentation, story navigation and media lifecycle for Instagram */
(function () {
  'use strict';

  if (window.top !== window || !/^(.*\.)?instagram\.com$/i.test(window.location.hostname)) return;

  const STYLE_ID = 'egoist-lagom-ig-engine';
  const STORY_FLIP_DELAY = 300;
  const STORY_WHEEL_THRESHOLD = 40;
  const STORY_GESTURE_GAP = 160;
  const STORY_SELECTOR = 'a[href^="/stories/"], a[href^="https://www.instagram.com/stories/"]';
  const CSS_STYLES = `
    :root { --egoist-font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { font-family: var(--egoist-font-family) !important; -webkit-font-smoothing: antialiased; }
    [role="heading"], input, textarea, button { font-family: var(--egoist-font-family) !important; }
    .egoistRelayDirect svg rect { animation: none !important; }
    ::-webkit-scrollbar { width: 0.5rem; height: 0.5rem; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #8888; border-radius: 0.5rem; }
    ::-webkit-scrollbar-thumb:hover { background: #888c; }
  `;
  const pausedVideos = new Set();
  const observedVideos = new WeakSet();
  const videoPreloads = new WeakMap();
  let isAppActive = false;
  let isActive = false;
  let lastStoryFlip = -Infinity;
  let lastStoryWheel = 0;
  let storyWheelDelta = 0;

  function getStoriesScroller(target) {
    let container = target;
    while (container && container !== document.body) {
      const bounds = container.getBoundingClientRect();
      if (bounds.height > 30 && bounds.height < 240
        && container.scrollWidth > container.clientWidth + 2
        && container.querySelector(STORY_SELECTOR)) {
        const overflow = getComputedStyle(container).overflowX;
        if (overflow === 'auto' || overflow === 'scroll') return container;
      }
      container = container.parentElement;
    }
    return undefined;
  }

  function getStoryButton(direction) {
    const labels = direction > 0
      ? /^(next|next story|далее|вперед|вперёд|следующая история)$/i
      : /^(previous|previous story|back|назад|предыдущая история)$/i;
    return Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true'
        || button.closest('[inert], [aria-hidden="true"]')) return false;
      const label = button.getAttribute('aria-label')
        || button.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
      const bounds = button.getBoundingClientRect();
      return labels.test(label.trim()) && bounds.width > 0 && bounds.height > 0
        && bounds.bottom > 0 && bounds.top < window.innerHeight
        && bounds.right > 0 && bounds.left < window.innerWidth
        && getComputedStyle(button).visibility === 'visible';
    });
  }

  function handleWheel(event) {
    const target = event.target instanceof Element ? event.target : undefined;
    if (!target || !isActive || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || target.isContentEditable || target.closest('input, textarea, [role="textbox"]')) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
    if (!delta) return;

    if (window.location.pathname.startsWith('/stories/')) {
      let container = target;
      while (container && container !== document.body) {
        const overflow = getComputedStyle(container).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll')
          && container.scrollHeight > container.clientHeight + 2) return;
        container = container.parentElement;
      }
      const button = getStoryButton(delta);
      if (!button) return;
      const now = performance.now();
      if (now - lastStoryWheel > STORY_GESTURE_GAP || Math.sign(delta) !== Math.sign(storyWheelDelta)) {
        storyWheelDelta = 0;
      }
      lastStoryWheel = now;
      storyWheelDelta += delta;
      event.preventDefault();
      if (now - lastStoryFlip < STORY_FLIP_DELAY || Math.abs(storyWheelDelta) < STORY_WHEEL_THRESHOLD) return;
      storyWheelDelta = 0;
      lastStoryFlip = now;
      button.click();
      return;
    }

    // Horizontal trackpad gestures retain their native scrolling
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const scroller = getStoriesScroller(target);
    if (!scroller) return;
    const previousLeft = scroller.scrollLeft;
    scroller.scrollLeft += delta;
    if (scroller.scrollLeft !== previousLeft) event.preventDefault();
  }

  function setActive(active) {
    isAppActive = active;
    updateVisibility();
  }

  function updateVisibility() {
    isActive = isAppActive && !document.hidden;
    if (!isActive) {
      document.querySelectorAll('video').forEach((video) => {
        if (!video.paused && !video.ended) {
          pausedVideos.add(video);
          video.pause();
        }
      });
    }
    document.querySelectorAll('video').forEach((video) => {
      if (videoPreloads.get(video) !== 'auto' || !video.paused) return;
      const bounds = video.getBoundingClientRect();
      const isVisible = bounds.bottom > 0 && bounds.top < window.innerHeight
        && bounds.right > 0 && bounds.left < window.innerWidth;
      video.preload = isActive && isVisible ? 'auto' : 'metadata';
    });
    if (!isActive) return;
    pausedVideos.forEach((video) => {
      const bounds = video.getBoundingClientRect();
      if (video.isConnected && bounds.bottom > 0 && bounds.top < window.innerHeight
        && bounds.right > 0 && bounds.left < window.innerWidth) {
        video.play().catch(() => {});
      }
    });
    pausedVideos.clear();
  }

  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target: video, isIntersecting }) => {
      if (videoPreloads.get(video) === 'auto' && video.paused) {
        video.preload = isIntersecting && isActive ? 'auto' : 'metadata';
      }
    });
  });

  function observeVideos(container) {
    const videos = container instanceof HTMLVideoElement ? [container] : container.querySelectorAll('video');
    videos.forEach((video) => {
      if (observedVideos.has(video)) return;
      observedVideos.add(video);
      if (!videoPreloads.has(video)) videoPreloads.set(video, video.preload);
      if (video.preload === 'auto' && video.paused) video.preload = 'metadata';
      videoObserver.observe(video);
    });
  }

  function forgetVideos(container) {
    const videos = container instanceof HTMLVideoElement ? [container] : container.querySelectorAll('video');
    videos.forEach((video) => {
      if (video.isConnected) return;
      videoObserver.unobserve(video);
      observedVideos.delete(video);
      pausedVideos.delete(video);
    });
  }

  function initialize() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS_STYLES;
      (document.head || document.documentElement).appendChild(style);
    }
    observeVideos(document);
    updatePresentationRoute();
    const observer = new MutationObserver((records) => {
      updatePresentationRoute();
      records.forEach(({ addedNodes, removedNodes }) => {
        removedNodes.forEach((node) => { if (node instanceof Element) forgetVideos(node); });
        addedNodes.forEach((node) => { if (node instanceof Element) observeVideos(node); });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function updatePresentationRoute() {
    // Decorative DM skeletons animate layout properties even after content is ready
    document.documentElement.classList.toggle('egoistRelayDirect', window.location.pathname.startsWith('/direct/'));
  }

  window.__egoistRelaySetActive = setActive;
  window.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('popstate', updatePresentationRoute);
  document.addEventListener('visibilitychange', updateVisibility);
  document.addEventListener('play', (event) => {
    if (!isActive && event.target instanceof HTMLVideoElement) {
      pausedVideos.add(event.target);
      event.target.pause();
      if (videoPreloads.get(event.target) === 'auto') event.target.preload = 'metadata';
    }
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
