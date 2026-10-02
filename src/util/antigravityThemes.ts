export interface AntigravityThemeDefinition {
  id: string;
  name: string;
  category: 'dark' | 'light';
  base: 'dark' | 'light';
  variables: Record<string, string>;
}

export const ANTIGRAVITY_THEMES: AntigravityThemeDefinition[] = [
  {
    id: 'egoist-dark',
    name: 'Egoist Lagom (OLED Pure Black)',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#000000',
      '--color-background-secondary': '#14161A',
      '--color-background-sidebar': '#0A0B0E',
      '--color-background-own': '#1C2433',
      '--color-background-own-apple': '#1C2433',
      '--color-background-selected': '#1C1F24',
      '--color-background-own-selected': '#253346',
      '--color-chat-hover': '#14161A',
      '--color-chat-active': '#1C1F24',
      '--color-item-hover': '#14161A',
      '--color-item-active': '#1C1F24',
      '--color-text': '#FFFFFF',
      '--color-text-secondary': '#71767B',
      '--color-borders': '#22252A',
      '--color-borders-input': '#2A2D34',
      '--color-dividers': '#22252A',
      '--color-primary': '#FFFFFF',
      '--color-links': '#1D9BF0',
      '--color-active': '#FFFFFF',
      '--color-background-compact-menu': '#16181DDD',
      '--color-background-compact-menu-reactions': '#16181DDD',
      '--color-background-compact-menu-hover': 'rgba(255, 255, 255, 0.1)',
    },
  },
  {
    id: 'dark-modern',
    name: 'Dark Modern',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#181818',
      '--color-background-secondary': '#1F1F1F',
      '--color-background-secondary-accent': '#262626',
      '--color-background-sidebar': '#181818',
      '--color-background-own': '#1C2433',
      '--color-background-own-apple': '#1C2433',
      '--color-background-selected': '#2A2D32',
      '--color-background-own-selected': '#253346',
      '--color-chat-hover': '#242424',
      '--color-chat-active': '#2B2B2B',
      '--color-item-hover': '#242424',
      '--color-item-active': '#2B2B2B',
      '--color-text': '#CCCCCC',
      '--color-text-secondary': '#8B949E',
      '--color-borders': '#2D2D2D',
      '--color-borders-input': '#3C3C3C',
      '--color-dividers': '#2D2D2D',
      '--color-primary': '#0078D4',
      '--color-links': '#3794FF',
      '--color-active': '#0078D4',
      '--color-background-compact-menu': 'rgba(24, 24, 24, 0.96)',
      '--color-background-compact-menu-reactions': 'rgba(24, 24, 24, 0.96)',
      '--color-background-compact-menu-hover': 'rgba(255, 255, 255, 0.1)',
    },
  },
  {
    id: 'dark-plus',
    name: 'Dark+ (Default Dark)',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#1E1E1E',
      '--color-background-secondary': '#252526',
      '--color-background-secondary-accent': '#2D2D30',
      '--color-background-sidebar': '#1E1E1E',
      '--color-background-own': '#264F78',
      '--color-background-own-apple': '#264F78',
      '--color-background-selected': '#2A2D2E',
      '--color-background-own-selected': '#336699',
      '--color-chat-hover': '#2A2D2E',
      '--color-chat-active': '#37373D',
      '--color-item-hover': '#2A2D2E',
      '--color-item-active': '#37373D',
      '--color-text': '#D4D4D4',
      '--color-text-secondary': '#9DA5B4',
      '--color-borders': '#333333',
      '--color-borders-input': '#3C3C3C',
      '--color-dividers': '#333333',
      '--color-primary': '#0E639C',
      '--color-links': '#4FC1FF',
      '--color-active': '#0E639C',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#1A1B26',
      '--color-background-secondary': '#24283B',
      '--color-background-secondary-accent': '#2F354F',
      '--color-background-sidebar': '#16161E',
      '--color-background-own': '#292E42',
      '--color-background-own-apple': '#292E42',
      '--color-background-selected': '#2E334D',
      '--color-background-own-selected': '#3B4261',
      '--color-chat-hover': '#202334',
      '--color-chat-active': '#292E42',
      '--color-item-hover': '#202334',
      '--color-item-active': '#292E42',
      '--color-text': '#C0CAF5',
      '--color-text-secondary': '#7982A9',
      '--color-borders': '#292E42',
      '--color-borders-input': '#3B4261',
      '--color-dividers': '#292E42',
      '--color-primary': '#7AA2F7',
      '--color-links': '#7DCFFF',
      '--color-active': '#7AA2F7',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai Pro Charcoal',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#1E1F1C',
      '--color-background-secondary': '#272822',
      '--color-background-secondary-accent': '#32342B',
      '--color-background-sidebar': '#191A17',
      '--color-background-own': '#3E3D32',
      '--color-background-own-apple': '#3E3D32',
      '--color-background-selected': '#34352D',
      '--color-background-own-selected': '#49483E',
      '--color-chat-hover': '#272822',
      '--color-chat-active': '#34352D',
      '--color-item-hover': '#272822',
      '--color-item-active': '#34352D',
      '--color-text': '#F8F8F2',
      '--color-text-secondary': '#88846F',
      '--color-borders': '#3E3D32',
      '--color-borders-input': '#49483E',
      '--color-dividers': '#3E3D32',
      '--color-primary': '#A6E22E',
      '--color-links': '#66D9EF',
      '--color-active': '#A6E22E',
    },
  },
  {
    id: 'abyss',
    name: 'Abyss Navy',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#000C18',
      '--color-background-secondary': '#061528',
      '--color-background-secondary-accent': '#0E223D',
      '--color-background-sidebar': '#000812',
      '--color-background-own': '#0F2B4C',
      '--color-background-own-apple': '#0F2B4C',
      '--color-background-selected': '#122D4F',
      '--color-background-own-selected': '#1A3F6D',
      '--color-chat-hover': '#081B33',
      '--color-chat-active': '#0E2849',
      '--color-item-hover': '#081B33',
      '--color-item-active': '#0E2849',
      '--color-text': '#B0C4DE',
      '--color-text-secondary': '#5C7E9F',
      '--color-borders': '#132B45',
      '--color-borders-input': '#1A3F6D',
      '--color-dividers': '#132B45',
      '--color-primary': '#2B7489',
      '--color-links': '#38A7CE',
      '--color-active': '#2B7489',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    category: 'dark',
    base: 'dark',
    variables: {
      '--color-background': '#002B36',
      '--color-background-secondary': '#073642',
      '--color-background-secondary-accent': '#0A4352',
      '--color-background-sidebar': '#00212B',
      '--color-background-own': '#0C4B5B',
      '--color-background-own-apple': '#0C4B5B',
      '--color-background-selected': '#0E5567',
      '--color-background-own-selected': '#12667A',
      '--color-chat-hover': '#073642',
      '--color-chat-active': '#0A4352',
      '--color-item-hover': '#073642',
      '--color-item-active': '#0A4352',
      '--color-text': '#93A1A1',
      '--color-text-secondary': '#657B83',
      '--color-borders': '#073642',
      '--color-borders-input': '#0A4352',
      '--color-dividers': '#073642',
      '--color-primary': '#268BD2',
      '--color-links': '#2AA198',
      '--color-active': '#268BD2',
    },
  },
  {
    id: 'light-modern',
    name: 'Light Modern',
    category: 'light',
    base: 'light',
    variables: {
      '--color-background': '#F8F8F8',
      '--color-background-secondary': '#FFFFFF',
      '--color-background-secondary-accent': '#F0F0F0',
      '--color-background-sidebar': '#F3F3F3',
      '--color-background-own': '#E5EBF1',
      '--color-background-own-apple': '#E5EBF1',
      '--color-background-selected': '#E8EEF5',
      '--color-background-own-selected': '#D8E2EC',
      '--color-chat-hover': '#EAEAEA',
      '--color-chat-active': '#DFDFDF',
      '--color-item-hover': '#EAEAEA',
      '--color-item-active': '#DFDFDF',
      '--color-text': '#1F1F1F',
      '--color-text-secondary': '#6E7681',
      '--color-borders': '#E5E5E5',
      '--color-borders-input': '#CCCCCC',
      '--color-dividers': '#E5E5E5',
      '--color-primary': '#005FB8',
      '--color-links': '#0969DA',
      '--color-active': '#005FB8',
    },
  },
  {
    id: 'light-plus',
    name: 'Light+ (Default Light)',
    category: 'light',
    base: 'light',
    variables: {
      '--color-background': '#FFFFFF',
      '--color-background-secondary': '#F3F3F3',
      '--color-background-secondary-accent': '#EAEAEA',
      '--color-background-sidebar': '#F8F8F8',
      '--color-background-own': '#EFF6FC',
      '--color-background-own-apple': '#EFF6FC',
      '--color-background-selected': '#E5E5E5',
      '--color-background-own-selected': '#DEECF9',
      '--color-chat-hover': '#F0F0F0',
      '--color-chat-active': '#E5E5E5',
      '--color-item-hover': '#F0F0F0',
      '--color-item-active': '#E5E5E5',
      '--color-text': '#000000',
      '--color-text-secondary': '#616161',
      '--color-borders': '#E0E0E0',
      '--color-borders-input': '#CCCCCC',
      '--color-dividers': '#E0E0E0',
      '--color-primary': '#007ACC',
      '--color-links': '#0066BF',
      '--color-active': '#007ACC',
    },
  },
  {
    id: 'quiet-light',
    name: 'Quiet Light',
    category: 'light',
    base: 'light',
    variables: {
      '--color-background': '#F5F5F5',
      '--color-background-secondary': '#FFFFFF',
      '--color-background-secondary-accent': '#EAE7E0',
      '--color-background-sidebar': '#EDECE6',
      '--color-background-own': '#E4DFE8',
      '--color-background-own-apple': '#E4DFE8',
      '--color-background-selected': '#DFD9E3',
      '--color-background-own-selected': '#D4CCDC',
      '--color-chat-hover': '#EDEAE3',
      '--color-chat-active': '#E2DDD4',
      '--color-item-hover': '#EDEAE3',
      '--color-item-active': '#E2DDD4',
      '--color-text': '#333333',
      '--color-text-secondary': '#7A7A7A',
      '--color-borders': '#DAD8D2',
      '--color-borders-input': '#C8C5BD',
      '--color-dividers': '#DAD8D2',
      '--color-primary': '#7A3E9D',
      '--color-links': '#4A6984',
      '--color-active': '#7A3E9D',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    category: 'light',
    base: 'light',
    variables: {
      '--color-background': '#FDF6E3',
      '--color-background-secondary': '#EEE8D5',
      '--color-background-secondary-accent': '#E4DCBF',
      '--color-background-sidebar': '#F7F0DC',
      '--color-background-own': '#E8DFC9',
      '--color-background-own-apple': '#E8DFC9',
      '--color-background-selected': '#DDD2BA',
      '--color-background-own-selected': '#D1C4AA',
      '--color-chat-hover': '#EBE3CE',
      '--color-chat-active': '#E0D6BD',
      '--color-item-hover': '#EBE3CE',
      '--color-item-active': '#E0D6BD',
      '--color-text': '#586E75',
      '--color-text-secondary': '#839496',
      '--color-borders': '#DFD7C2',
      '--color-borders-input': '#D0C6AE',
      '--color-dividers': '#DFD7C2',
      '--color-primary': '#268BD2',
      '--color-links': '#2AA198',
      '--color-active': '#268BD2',
    },
  },
];

export function getActiveThemeVariantId(): string {
  try {
    return localStorage.getItem('egoist_theme_variant') || 'dark-modern';
  } catch {
    return 'dark-modern';
  }
}

export function applyAntigravityTheme(variantId: string): void {
  const theme = ANTIGRAVITY_THEMES.find((t) => t.id === variantId) || ANTIGRAVITY_THEMES[0];

  try {
    localStorage.setItem('egoist_theme_variant', theme.id);
  } catch {
    // Apply the selected theme for this session when local storage is unavailable
  }

  const root = document.documentElement;

  // Set base theme class for compatibility with built-in Telegram components
  root.classList.remove('theme-dark', 'theme-light');
  root.classList.add(theme.base === 'dark' ? 'theme-dark' : 'theme-light');

  // Remove other theme-variant-* classes
  ANTIGRAVITY_THEMES.forEach((t) => {
    root.classList.remove(`theme-variant-${t.id}`);
  });
  root.classList.add(`theme-variant-${theme.id}`);

  // Apply custom CSS variables directly on root element
  Object.entries(theme.variables).forEach(([prop, val]) => {
    root.style.setProperty(prop, val);
  });

  const themeColorTag = document.querySelector('meta[name="theme-color"]');
  if (themeColorTag) {
    themeColorTag.setAttribute('content', theme.variables['--color-background'] || '#000000');
  }
}
