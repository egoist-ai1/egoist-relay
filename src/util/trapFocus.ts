type FocusTrap = { element: HTMLElement; previousFocus?: HTMLElement };
const activeTraps: FocusTrap[] = [];
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function trapFocus(element: HTMLElement, previousFocus?: HTMLElement) {
  const trap = { element, previousFocus };
  activeTraps.push(trap);

  function getCanFocus(candidate: HTMLElement, isProgrammatic = false) {
    return candidate.isConnected && !candidate.matches(':disabled, [aria-disabled="true"]')
      && (candidate.tabIndex >= 0 || (isProgrammatic && candidate.hasAttribute('tabindex')))
      && !candidate.closest(
        '[inert], [hidden], [aria-hidden="true"], .not-shown, .Transition_slide-inactive',
      )
      && getComputedStyle(candidate).visibility !== 'hidden' && candidate.getClientRects().length > 0;
  }

  function getFocusableElements() {
    return Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (candidate) => getCanFocus(candidate),
    );
  }

  function focusInside() {
    const autofocus = element.querySelector<HTMLElement>('[autofocus]');
    const candidate = autofocus && getCanFocus(autofocus, true)
      ? autofocus : getFocusableElements()[0];
    (candidate || element).focus({ preventScroll: true });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Tab' || activeTraps[activeTraps.length - 1] !== trap) return;
    e.preventDefault();
    e.stopPropagation();
    const focusableElements = getFocusableElements();
    if (!focusableElements.length) {
      element.focus({ preventScroll: true });
      return;
    }
    const currentIndex = focusableElements.findIndex((candidate) => candidate === document.activeElement);
    const nextIndex = currentIndex < 0 ? (e.shiftKey ? focusableElements.length - 1 : 0)
      : (currentIndex + (e.shiftKey ? -1 : 1) + focusableElements.length) % focusableElements.length;
    focusableElements[nextIndex].focus({ preventScroll: true });
  }

  function handleFocusIn(e: FocusEvent) {
    if (activeTraps[activeTraps.length - 1] === trap && !element.contains(e.target as Node)) focusInside();
  }

  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('focusin', handleFocusIn);
  if (!element.contains(document.activeElement)) focusInside();

  return () => {
    const wasTopmost = activeTraps[activeTraps.length - 1] === trap;
    const index = activeTraps.indexOf(trap);
    if (index >= 0) activeTraps.splice(index, 1);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('focusin', handleFocusIn);
    if (!wasTopmost) return;
    const restoreFocus = () => {
      const parent = activeTraps[activeTraps.length - 1];
      if (previousFocus && getCanFocus(previousFocus) && (!parent || parent.element.contains(previousFocus))) {
        previousFocus.focus({ preventScroll: true });
      } else if (parent && !parent.element.contains(document.activeElement)) {
        const candidate = Array.from(parent.element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
          (item) => getCanFocus(item),
        );
        (candidate || parent.element).focus({ preventScroll: true });
      }
    };
    if (element instanceof HTMLDialogElement && element.open) {
      element.addEventListener('close', restoreFocus, { once: true });
    } else {
      restoreFocus();
    }
  };
}
