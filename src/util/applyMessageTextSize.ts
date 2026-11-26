import { requestMutation } from '../lib/fasterdom/fasterdom';
import { IS_IOS } from './browser/windowEnvironment';

const BASE_FONT_SIZE = 16;
const MIN_COMPOSER_FONT_SIZE = IS_IOS ? 16 : 15;

export default function applyMessageTextSize(size: number) {
  requestMutation(() => {
    const root = document.documentElement;
    root.style.setProperty('--composer-text-size', `${Math.max(size, MIN_COMPOSER_FONT_SIZE) / BASE_FONT_SIZE}rem`);
    root.style.setProperty('--message-meta-height', `${Math.floor(size * 1.25) / BASE_FONT_SIZE}rem`);
    root.style.setProperty('--message-text-size', `${size / BASE_FONT_SIZE}rem`);
    root.setAttribute('data-message-text-size', size.toString());
  });
}
