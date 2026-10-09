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
    [data-egoist-reel-scroller] { padding-top: 0 !important; }
    [data-egoist-reel-item] { height: var(--egoist-reel-h) !important; align-items: center !important; box-sizing: border-box !important; }
    [data-egoist-reel-unit] { transform: translateX(var(--egoist-reel-dx, 0px)) scale(var(--egoist-reel-scale, 1)); transform-origin: center center; flex: none; }
    [data-egoist-reel-hide] { display: none !important; }
  `;
  // Reels: каждая страница ленты занимает всю видимую область, ролик с кнопками центрируется и масштабируется
  const REELS_MARGIN = 10;
  const REELS_MAX_SCALE = 3;
  const REELS_BOTTOM_BAR_MAX = 160;
  const REELS_LIKE_LABEL = /^(отметки\s*["«“]?нравится["»”]?|likes?)$/i;
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
    if (isActive) fitReels();
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

  function isReelsRoute() {
    const path = window.location.pathname;
    return (path === '/reels' || path.startsWith('/reels/')) && !path.startsWith('/reels/audio/');
  }

  function clearReelsFit() {
    document.querySelectorAll('[data-egoist-reel-scroller], [data-egoist-reel-item], [data-egoist-reel-unit], [data-egoist-reel-hide]')
      .forEach((element) => {
        ['scroller', 'item', 'unit', 'hide'].forEach((name) => element.removeAttribute('data-egoist-reel-' + name));
        element.style.removeProperty('--egoist-reel-h');
        element.style.removeProperty('--egoist-reel-scale');
        element.style.removeProperty('--egoist-reel-dx');
      });
  }

  // Нижняя панель Instagram (узкая раскладка) перекрывает ленту: её высоту вычитаем из страницы ролика
  function getBottomBarHeight() {
    let height = 0;
    document.querySelectorAll('div, nav').forEach((element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width < window.innerWidth * 0.8 || bounds.height < 30 || bounds.height > REELS_BOTTOM_BAR_MAX
        || Math.abs(bounds.bottom - window.innerHeight) > 2) return;
      if (getComputedStyle(element).position === 'fixed') height = Math.max(height, bounds.height);
    });
    return height;
  }

  function getActiveReelVideo() {
    const visible = Array.from(document.querySelectorAll('video')).filter((video) => {
      const bounds = video.getBoundingClientRect();
      return bounds.width > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
    });
    return visible.find((video) => !video.paused) || visible[0];
  }

  function fitReels() {
    if (!isReelsRoute()) {
      clearReelsFit();
      return;
    }
    if (!isActive) return;
    const video = getActiveReelVideo();
    if (!video) return;
    let item = video;
    while (item && item !== document.body && getComputedStyle(item).scrollSnapAlign === 'none') item = item.parentElement;
    const scroller = item && item.parentElement;
    if (!scroller || item === document.body || !/y/.test(getComputedStyle(scroller).scrollSnapType)) return;
    const unit = item.firstElementChild;
    if (!unit || !unit.offsetWidth || !unit.offsetHeight) return;

    const pageHeight = Math.max(200, scroller.clientHeight - getBottomBarHeight());
    scroller.setAttribute('data-egoist-reel-scroller', '');
    const heightValue = pageHeight + 'px';
    if (scroller.style.getPropertyValue('--egoist-reel-h') !== heightValue) scroller.style.setProperty('--egoist-reel-h', heightValue);
    // Видимая ширина группы «ролик + кнопки» (от края ролика до правой иконки) в единицах раскладки
    const currentScale = parseFloat(scroller.style.getPropertyValue('--egoist-reel-scale')) || 1;
    const currentShift = parseFloat(scroller.style.getPropertyValue('--egoist-reel-dx')) || 0;
    const getVisualEdges = () => {
      let right = 0;
      unit.querySelectorAll('svg, img').forEach((icon) => {
        const bounds = icon.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) right = Math.max(right, bounds.right);
      });
      return { left: video.getBoundingClientRect().left, right };
    };
    const edges = getVisualEdges();
    const groupWidth = edges.right > edges.left ? (edges.right - edges.left) / currentScale : unit.offsetWidth;
    const scale = Math.max(1, Math.min(REELS_MAX_SCALE,
      (scroller.clientWidth - 2 * REELS_MARGIN) / groupWidth, pageHeight / unit.offsetHeight));
    const scaleValue = String(Math.floor(scale * 100) / 100);
    if (scroller.style.getPropertyValue('--egoist-reel-scale') !== scaleValue) scroller.style.setProperty('--egoist-reel-scale', scaleValue);
    // Равные поля слева и справа: после смены масштаба измеряем группу заново и сдвигаем
    const fitted = getVisualEdges();
    const shift = Math.round(currentShift + (scroller.clientWidth - fitted.right - fitted.left) / 2);
    if (fitted.right > fitted.left && Math.abs(shift - currentShift) >= 1) {
      scroller.style.setProperty('--egoist-reel-dx', shift + 'px');
    }
    Array.from(scroller.children).forEach((page) => {
      if (getComputedStyle(page).scrollSnapAlign === 'none') return;
      page.setAttribute('data-egoist-reel-item', '');
      const pageUnit = page.firstElementChild;
      if (!pageUnit) return;
      pageUnit.setAttribute('data-egoist-reel-unit', '');
      if (Math.abs(page.getBoundingClientRect().top) > window.innerHeight * 2) return;
      // Подпись «Отметки "Нравится"» под сердечком шире колонки кнопок: убираем, оставляем сердечко
      pageUnit.querySelectorAll('span, div').forEach((label) => {
        if (label.childElementCount === 0 && REELS_LIKE_LABEL.test(label.textContent.trim())) {
          label.setAttribute('data-egoist-reel-hide', '');
        }
      });
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
    // Комментарии и лента добавляют сотни узлов подряд: видео ищем один раз за кадр, а не на каждый узел
    const addedNodes = new Set();
    const removedNodes = new Set();
    let isFlushScheduled = false;
    const flush = () => {
      isFlushScheduled = false;
      updatePresentationRoute();
      fitReels();
      removedNodes.forEach((node) => forgetVideos(node));
      removedNodes.clear();
      addedNodes.forEach((node) => { if (node.isConnected) observeVideos(node); });
      addedNodes.clear();
    };
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.removedNodes.forEach((node) => { if (node instanceof Element) removedNodes.add(node); });
        record.addedNodes.forEach((node) => { if (node instanceof Element) addedNodes.add(node); });
      });
      if (isFlushScheduled) return;
      isFlushScheduled = true;
      // В скрытом WebView кадры не рисуются, но preload у новых видео надо сбросить сразу
      if (document.hidden) setTimeout(flush, 50); else window.requestAnimationFrame(flush);
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
  window.addEventListener('resize', () => window.requestAnimationFrame(fitReels));
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
