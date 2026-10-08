// Закрашивает страницу цветом выбранной темы до выполнения основного бандла: без белой вспышки при запуске.
// Значения фона — роли bg из src/util/lagomTheme.ts; остальные варианты тем применяет приложение при старте.
(function () {
  var variant = '';
  try {
    variant = window.localStorage.getItem('egoist_theme_variant') || '';
  } catch (e) {
    // Хранилище недоступно: действует тема по умолчанию
  }

  var isLight = variant === 'lagom-light';
  if (variant && variant !== 'lagom-dark' && !isLight) return;

  var root = document.documentElement;
  root.classList.add(isLight ? 'theme-light' : 'theme-dark');
  root.style.setProperty('--color-background', isLight ? '#F5F5F2' : '#0E0E0F');
}());
