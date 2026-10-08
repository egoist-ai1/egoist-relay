// Egoist DS, режим Lagom: роли Telegram Web A строятся из ролей дизайн-системы.
// Значения графита и семантики — из Материалы/Egoist Design System/tokens/tokens.json (тёмная и светлая темы).

export interface LagomRoles {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  // Граница поля ввода: не менее 3:1 к соседней поверхности (WCAG 1.4.11)
  control: string;
  text: string;
  textSoft: string;
  textMuted: string;
  // Подпись на самой светлой «поднятой» поверхности (собственный пузырь): запас контраста к surface3
  textMutedStrong: string;
  inverse: string;
  onInverse: string;
  danger: string;
  dangerShade: string;
  success: string;
  successShade: string;
  warning: string;
  shadow: string;
  shadowLight: string;
  // Фирменная сетка (Egoist Grid): линии и подписи графитовые, акцента нет
  gridInk: string;
  gridLabel: string;
  // Тень поднятых поверхностей (меню, окна)
  elevation: string;
  // Цвет спиннера на кнопке primary: контрастен к inverse
  spinnerOnPrimary: 'black' | 'white';
}

export const LAGOM_DARK: LagomRoles = {
  bg: '#0E0E0F',
  surface1: '#141416',
  surface2: '#1C1C1E',
  surface3: '#26262A',
  line: '#26262A',
  lineStrong: '#3A3A3D',
  control: '#646460',
  text: '#EDEBE6',
  textSoft: '#D6D5D0',
  textMuted: '#8C8A85',
  textMutedStrong: '#B5B3AD',
  inverse: '#EDEBE6',
  onInverse: '#0E0E0F',
  danger: '#FF5A4E',
  dangerShade: '#E04A3F',
  success: '#6FD08C',
  successShade: '#58B374',
  warning: '#EFB45B',
  shadow: '#000000CC',
  shadowLight: '#00000080',
  gridInk: '#3A3A3D',
  gridLabel: '#8C8A85',
  elevation: '0 1px 0 rgba(255, 255, 255, 0.05) inset, 0 16px 40px rgba(0, 0, 0, 0.55)',
  spinnerOnPrimary: 'black',
};

export const LAGOM_LIGHT: LagomRoles = {
  bg: '#F5F5F2',
  surface1: '#FFFFFF',
  surface2: '#EDEBE6',
  surface3: '#D6D5D0',
  line: '#D6D5D0',
  lineStrong: '#B5B3AD',
  control: '#8C8A85',
  text: '#0A0A0B',
  textSoft: '#26262A',
  textMuted: '#646460',
  textMutedStrong: '#3A3A3D',
  inverse: '#0E0E0F',
  onInverse: '#F5F5F2',
  danger: '#B3261E',
  dangerShade: '#8F1F18',
  success: '#1E7A3E',
  successShade: '#17602F',
  warning: '#8A5A00',
  shadow: '#0A0A0B33',
  shadowLight: '#0A0A0B1F',
  gridInk: '#B5B3AD',
  gridLabel: '#646460',
  elevation: '0 1px 2px rgba(10, 10, 11, 0.06), 0 12px 32px rgba(10, 10, 11, 0.1)',
  spinnerOnPrimary: 'white',
};

function channels(hex: string) {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
}

function rgb(hex: string) {
  return channels(hex).join(', ');
}

function alpha(hex: string, opacity: number) {
  return `rgba(${rgb(hex)}, ${opacity})`;
}

export function buildLagomVariables(roles: LagomRoles): Record<string, string> {
  const {
    bg, surface1, surface2, surface3, line, lineStrong, control, text, textSoft, textMuted, textMutedStrong,
    inverse, onInverse, danger, dangerShade, success, successShade, warning, shadow, shadowLight,
    gridInk, gridLabel, elevation, spinnerOnPrimary,
  } = roles;

  return {
    '--color-background': bg,
    '--color-background-secondary': surface1,
    '--color-background-secondary-accent': surface2,
    '--color-background-sidebar': bg,
    '--color-background-own': surface3,
    '--color-background-own-apple': surface3,
    '--color-background-selected': surface2,
    '--color-background-own-selected': lineStrong,
    '--color-background-compact-menu': `${surface2}F5`,
    '--color-background-compact-menu-reactions': `${surface2}F5`,
    '--color-background-compact-menu-hover': alpha(text, 0.1),
    '--color-background-menu-separator': line,
    '--color-web-app-browser': `${bg}EE`,
    '--color-webpage-initial-background': surface2,
    '--color-text': text,
    '--color-text-rgb': rgb(text),
    '--color-text-lighter': textSoft,
    '--color-text-secondary': textMuted,
    '--color-text-secondary-rgb': rgb(textMuted),
    '--color-text-secondary-apple': textMuted,
    '--color-text-meta': textMuted,
    '--color-text-meta-rgb': rgb(textMuted),
    '--color-text-meta-colored': textMuted,
    '--color-text-meta-apple': textMuted,
    '--color-icon-secondary': textMuted,
    '--color-text-green': textSoft,
    '--color-text-green-rgb': rgb(textSoft),
    '--color-borders': line,
    '--color-borders-input': control,
    '--color-borders-alternate': line,
    '--color-borders-read-story': line,
    '--color-dividers': line,
    '--color-dividers-android': line,
    '--color-primary': inverse,
    '--color-primary-text': onInverse,
    '--spinner-primary-data': `var(--spinner-${spinnerOnPrimary}-data)`,
    '--color-primary-shade': textSoft,
    '--color-primary-shade-darker': textMutedStrong,
    '--color-primary-shade-rgb': rgb(textSoft),
    '--color-primary-opacity': alpha(inverse, 0.2),
    '--color-primary-opacity-hover': alpha(inverse, 0.25),
    '--color-primary-tint': alpha(inverse, 0.1),
    '--color-active': inverse,
    '--color-active-darker': textMutedStrong,
    '--color-green': success,
    '--color-green-darker': successShade,
    '--color-green-rgb': rgb(success),
    '--color-success': success,
    '--color-error': danger,
    '--color-error-shade': dangerShade,
    '--color-error-rgb': rgb(danger),
    '--color-warning': warning,
    '--color-links': text,
    '--color-own-links': text,
    '--color-placeholders': textMuted,
    '--color-list-icon': textSoft,
    '--color-gray': textMuted,
    '--color-interactive-active': inverse,
    '--color-interactive-inactive': alpha(textMuted, 0.25),
    '--color-interactive-buffered': alpha(textMuted, 0.25),
    '--color-interactive-element-hover': alpha(textMuted, 0.08),
    '--color-composer-button': textMuted,
    '--color-code': text,
    '--color-code-own': text,
    '--color-code-bg': alpha(text, 0.06),
    '--color-code-own-bg': alpha(text, 0.08),
    '--color-accent-own': text,
    '--color-accent-own-rgb': rgb(text),
    '--color-message-meta-own': textMutedStrong,
    '--color-message-reaction': surface3,
    '--color-message-reaction-hover': lineStrong,
    '--color-message-reaction-own': lineStrong,
    '--color-message-reaction-hover-own': control,
    '--color-message-reaction-chosen-hover': textSoft,
    '--color-message-reaction-chosen-hover-own': textSoft,
    '--color-message-non-contact': textMuted,
    '--color-message-story-mention-from': textMuted,
    '--color-message-story-mention-to': textSoft,
    '--color-reply-hover': surface3,
    '--color-reply-active': lineStrong,
    '--color-reply-own-hover': lineStrong,
    '--color-reply-own-active': control,
    '--color-reply-own-hover-apple': lineStrong,
    '--color-reply-own-active-apple': control,
    '--color-chat-username': text,
    '--color-chat-hover': surface1,
    '--color-chat-active': surface3,
    '--color-chat-active-text': text,
    '--color-chat-active-greyed': surface2,
    '--color-item-hover': surface1,
    '--color-item-active': surface3,
    '--color-voice-transcribe-button': surface3,
    '--color-voice-transcribe-button-own': lineStrong,
    '--color-selection-highlight': lineStrong,
    '--color-selection-highlight-emoji': alpha(lineStrong, 0.7),
    '--color-telegram-blue': text,
    '--color-topic-blue': text,
    '--color-topic-yellow': textSoft,
    '--color-topic-violet': textMutedStrong,
    '--color-topic-green': textMuted,
    '--color-topic-rose': control,
    '--color-topic-red': lineStrong,
    '--color-topic-grey': control,
    '--color-forum-hover-unread-topic': surface1,
    '--color-forum-unread-topic-hover': surface1,
    '--color-forum-hover-unread-topic-hover': surface2,
    '--color-deleted-account': textMuted,
    '--color-archive': textMuted,
    '--color-default-shadow': shadow,
    '--color-light-shadow': shadowLight,
    '--color-skeleton-background': alpha(textMuted, 0.15),
    '--color-skeleton-foreground': alpha(text, 0.12),
    '--color-scrollbar': alpha(textMuted, 0.3),
    '--color-scrollbar-code': alpha(textMuted, 0.3),
    '--color-hover-overlay': alpha(text, 0.04),
    '--color-toast-background': `${surface2}EE`,
    '--color-toast-text': text,
    '--shadow': elevation,
    '--grid-ink': gridInk,
    '--grid-label': gridLabel,
  };
}
