import Color from 'colorjs.io';
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';

import { ANTIGRAVITY_THEMES, applyAntigravityTheme, getActiveThemeVariantId } from './antigravityThemes';

const EXISTING_THEME_IDS = [
  'egoist-dark', 'dark-modern', 'dark-plus', 'tokyo-night', 'monokai', 'abyss', 'solarized-dark',
  'light-modern', 'light-plus', 'quiet-light', 'solarized-light',
];
const NEUTRAL_COLOR_ROLES = [
  '--color-background', '--color-background-secondary', '--color-background-secondary-accent',
  '--color-background-sidebar', '--color-background-own', '--color-background-own-apple',
  '--color-background-selected', '--color-background-own-selected', '--color-background-compact-menu',
  '--color-background-compact-menu-reactions', '--color-background-menu-separator',
  '--color-text', '--color-text-lighter', '--color-text-secondary', '--color-text-secondary-apple',
  '--color-text-meta', '--color-text-meta-colored', '--color-text-meta-apple', '--color-icon-secondary',
  '--color-borders', '--color-borders-input', '--color-borders-alternate', '--color-borders-read-story',
  '--color-dividers', '--color-dividers-android', '--color-primary', '--color-primary-text',
  '--color-primary-shade', '--color-primary-shade-darker', '--color-primary-opacity',
  '--color-primary-opacity-hover', '--color-primary-tint', '--color-active', '--color-active-darker',
  '--color-links', '--color-own-links', '--color-placeholders', '--color-list-icon',
  '--color-code', '--color-code-own', '--color-composer-button', '--color-accent-own',
  '--color-message-meta-own', '--color-message-reaction', '--color-message-reaction-hover',
  '--color-message-reaction-own', '--color-message-reaction-hover-own',
  '--color-message-reaction-chosen-hover', '--color-message-reaction-chosen-hover-own',
  '--color-reply-hover', '--color-reply-active', '--color-reply-own-hover', '--color-reply-own-active',
  '--color-reply-own-hover-apple', '--color-reply-own-active-apple', '--color-chat-username',
  '--color-chat-hover', '--color-chat-active', '--color-item-hover', '--color-item-active',
  '--color-voice-transcribe-button', '--color-voice-transcribe-button-own', '--color-telegram-blue',
  '--color-selection-highlight', '--color-selection-highlight-emoji',
];
const RGB_ROLES = [
  '--color-text', '--color-text-secondary', '--color-text-meta', '--color-primary-shade', '--color-accent-own',
];

let themeColorTag: HTMLMetaElement;
let baseStyle: HTMLStyleElement;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  themeColorTag = document.createElement('meta');
  themeColorTag.name = 'theme-color';
  document.head.appendChild(themeColorTag);
  baseStyle = document.createElement('style');
  baseStyle.textContent = `:root {
    --color-primary-text: #ffffff;
    --color-success: #00c73e;
    --color-error: #e53935;
    --color-warning: #fb8c00;
  }`;
  document.head.appendChild(baseStyle);
});

afterEach(() => {
  vi.restoreAllMocks();
  themeColorTag.remove();
  baseStyle.remove();
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

describe('Relay theme selection', () => {
  test('Starts a fresh profile with the OLED theme', () => {
    applyAntigravityTheme(getActiveThemeVariantId());

    expect(document.documentElement.classList.contains('theme-variant-egoist-dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--color-background')).toBe('#000000');
  });

  test.each(EXISTING_THEME_IDS)('Keeps a saved %s variant across startup', (variantId) => {
    localStorage.setItem('egoist_theme_variant', variantId);

    applyAntigravityTheme(getActiveThemeVariantId());

    expect(document.documentElement.classList.contains(`theme-variant-${variantId}`)).toBe(true);
    expect(localStorage.getItem('egoist_theme_variant')).toBe(variantId);
  });

  test('Recovers an unsupported saved variant to the OLED theme', () => {
    localStorage.setItem('egoist_theme_variant', 'removed-theme');

    expect(getActiveThemeVariantId()).toBe('egoist-dark');
    applyAntigravityTheme(getActiveThemeVariantId());
    expect(localStorage.getItem('egoist_theme_variant')).toBe('egoist-dark');
  });

  test('Uses the default when storage access is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage is unavailable');
    });

    applyAntigravityTheme(getActiveThemeVariantId());

    expect(document.documentElement.classList.contains('theme-variant-egoist-dark')).toBe(true);
  });

  test('Applies a requested theme for the session when persistence is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is unavailable');
    });

    expect(() => applyAntigravityTheme('quiet-light')).not.toThrow();
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(document.documentElement.classList.contains('theme-variant-quiet-light')).toBe(true);
  });
});

describe('Neutral Telegram palette', () => {
  test('Applies neutral control, bubble and metadata colors without inherited blue', () => {
    applyAntigravityTheme('egoist-dark');
    const style = getComputedStyle(document.documentElement);

    NEUTRAL_COLOR_ROLES.forEach((role) => {
      const value = style.getPropertyValue(role).trim();
      expect(value, role).not.toBe('');
      const [red, green, blue] = readRgbChannels(value);
      expect(red, role).toBeCloseTo(green);
      expect(blue, role).toBeCloseTo(green);
    });
  });

  test('Keeps metadata and secondary controls readable on raised surfaces', () => {
    applyAntigravityTheme('egoist-dark');
    const style = getComputedStyle(document.documentElement);

    ['--color-text-secondary', '--color-text-meta', '--color-message-meta-own', '--color-icon-secondary']
      .forEach((role) => {
        const value = style.getPropertyValue(role).trim();
        expect(value, role).not.toBe('');
        const channels = readRgbChannels(value);
        channels.forEach((channel) => expect(channel, role).toBeGreaterThanOrEqual(160 / 255));
      });
  });

  test('Aligns RGB roles with their displayed colors', () => {
    applyAntigravityTheme('egoist-dark');
    const style = getComputedStyle(document.documentElement);

    RGB_ROLES.forEach((role) => {
      const value = style.getPropertyValue(role).trim();
      expect(value, role).not.toBe('');
      const channels = readRgbChannels(value);
      const rgb = style.getPropertyValue(`${role}-rgb`).split(',').map(Number);
      expect(rgb, role).toEqual(channels.map((channel) => Math.round(channel * 255)));
    });
  });

  test('Keeps success, warning and error states distinguishable from neutral controls', () => {
    applyAntigravityTheme('egoist-dark');
    const style = getComputedStyle(document.documentElement);
    const [successRed, successGreen] = readRgbChannels(style.getPropertyValue('--color-success').trim());
    const [errorRed, errorGreen] = readRgbChannels(style.getPropertyValue('--color-error').trim());
    const [warningRed, , warningBlue] = readRgbChannels(style.getPropertyValue('--color-warning').trim());

    expect(successGreen).toBeGreaterThan(successRed);
    expect(errorRed).toBeGreaterThan(errorGreen);
    expect(warningRed).toBeGreaterThan(warningBlue);
  });
});

describe('Primary control contrast', () => {
  test.each(EXISTING_THEME_IDS)('Keeps primary text readable in %s', (variantId) => {
    applyAntigravityTheme(variantId);
    const variables = getComputedStyle(document.documentElement);
    const background = variables.getPropertyValue('--color-primary').trim();
    const foreground = variables.getPropertyValue('--color-primary-text').trim();

    expect(Color.contrastWCAG21(background, foreground)).toBeGreaterThanOrEqual(4.5);
  });
});
describe('Theme switching boundaries', () => {
  test.each(EXISTING_THEME_IDS.slice(1))('Preserves unrelated properties when switching to %s', (variantId) => {
    document.documentElement.style.setProperty('--relay-test-unrelated', 'preserved');
    applyAntigravityTheme('egoist-dark');
    expect(document.documentElement.style.getPropertyValue('--color-primary-text')).toBe('#000000');
    applyAntigravityTheme(variantId);

    const expectedForeground = ANTIGRAVITY_THEMES.find((theme) => theme.id === variantId)!
      .variables['--color-primary-text'];
    expect(document.documentElement.style.getPropertyValue('--color-primary-text')).toBe(expectedForeground || '');
    expect(getComputedStyle(document.documentElement).getPropertyValue('--color-primary-text').trim())
      .toBe(expectedForeground || '#ffffff');
    expect(document.documentElement.style.getPropertyValue('--color-message-meta-own')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--relay-test-unrelated')).toBe('preserved');
    expect(document.documentElement.classList.contains('theme-variant-egoist-dark')).toBe(false);
  });

  test('Removes a compact menu override when the next variant uses its base style', () => {
    applyAntigravityTheme('dark-modern');
    applyAntigravityTheme('dark-plus');

    expect(document.documentElement.style.getPropertyValue('--color-background-compact-menu')).toBe('');
  });

  test('Updates the OS theme color metadata when changing between light and OLED', () => {
    applyAntigravityTheme('light-modern');
    expect(themeColorTag.content).toBe('#F8F8F8');
    applyAntigravityTheme('egoist-dark');
    expect(themeColorTag.content).toBe('#000000');
    expect(document.documentElement.classList.contains('theme-light')).toBe(false);
    expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
  });

  test('Applies the OLED fallback for an unknown requested variant', () => {
    applyAntigravityTheme('unknown-theme');

    expect(localStorage.getItem('egoist_theme_variant')).toBe('egoist-dark');
    expect(themeColorTag.content).toBe('#000000');
  });
});

function readRgbChannels(value: string) {
  return new Color(value).to('srgb').coords.map((channel) => {
    expect(typeof channel).toBe('number');
    return channel!;
  });
}
