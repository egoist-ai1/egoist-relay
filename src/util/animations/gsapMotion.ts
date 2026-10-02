import { gsap } from 'gsap';

/**
 * Performs a clean, high-performance staggered entrance animation on a container's key children.
 */
export function animateEntrance(container?: HTMLElement, delay = 0.05) {
  if (!container) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const targets = container.querySelectorAll(
    '#logo, .qr-outer, h1, .note, ol, .form-control, .input-group, .Checkbox, .auth-button, button[type="submit"]',
  );

  if (!targets.length) return;

  const animation = gsap.fromTo(
    targets,
    {
      opacity: 0,
      y: 14,
      scale: 0.98,
    },
    {
      opacity: 1,
      y: 0,
      scale: 1,
      duration: 0.4,
      ease: 'power3.out',
      stagger: 0.04,
      delay,
      clearProps: 'transform,opacity',
    },
  );

  return () => {
    animation.revert();
  };
}

/**
 * Micro-interaction on tactile button clicks using GSAP
 */
export function animateButtonPress(button?: HTMLElement) {
  if (!button) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  gsap.to(button, {
    scale: 0.97,
    duration: 0.1,
    ease: 'power2.out',
    yoyo: true,
    repeat: 1,
  });
}
