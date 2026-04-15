/**
 * Shared animation primitives for the Jellyclaw dashboard.
 *
 * Inject `ANIMATIONS_CSS` once at the app root (e.g. via a <style> tag or
 * imported from a top-level CSS file). Then use the class names below
 * on any element.
 *
 * Classes:
 *   animate-shimmer         — skeleton loading gradient
 *   animate-pulse-gold      — in-progress gold pulse
 *   animate-slide-in-right  — panel opening from right
 *   animate-fade-scale-in   — modal/tooltip entrance
 *   animate-press           — button tactile press (scale 0.98)
 *   animate-hover-lift      — card hover glow + scale(1.01)
 *
 * All animations respect `prefers-reduced-motion`.
 */

export const CLASS = {
  shimmer: "animate-shimmer",
  pulseGold: "animate-pulse-gold",
  slideInRight: "animate-slide-in-right",
  fadeScaleIn: "animate-fade-scale-in",
  press: "animate-press",
  hoverLift: "animate-hover-lift",
} as const;

export const ANIMATIONS_CSS = `
@keyframes jc-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
@keyframes jc-pulse-gold {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(146, 132, 102, 0.55),
                0 0 8px 0 rgba(146, 132, 102, 0.35);
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 0 6px rgba(146, 132, 102, 0),
                0 0 12px 0 rgba(146, 132, 102, 0.6);
    opacity: 0.85;
  }
}
@keyframes jc-slide-in-right {
  from { transform: translateX(16px); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}
@keyframes jc-fade-scale-in {
  from { transform: scale(0.96); opacity: 0; }
  to   { transform: scale(1);    opacity: 1; }
}

.${CLASS.shimmer} {
  background: linear-gradient(
    90deg,
    rgba(146, 132, 102, 0.06) 0%,
    rgba(146, 132, 102, 0.22) 50%,
    rgba(146, 132, 102, 0.06) 100%
  );
  background-size: 200% 100%;
  animation: jc-shimmer 1.6s linear infinite;
}

.${CLASS.pulseGold} {
  animation: jc-pulse-gold 1.8s ease-in-out infinite;
}

.${CLASS.slideInRight} {
  animation: jc-slide-in-right 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.${CLASS.fadeScaleIn} {
  animation: jc-fade-scale-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.${CLASS.press} {
  transition: transform 90ms ease-out;
}
.${CLASS.press}:active {
  transform: scale(0.98);
}

.${CLASS.hoverLift} {
  transition:
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms ease,
    box-shadow 200ms ease;
  border: 1px solid rgba(146, 132, 102, 0.15);
}
.${CLASS.hoverLift}:hover {
  transform: scale(1.01);
  border-color: rgba(146, 132, 102, 0.5);
  box-shadow:
    0 0 0 1px rgba(146, 132, 102, 0.18),
    0 4px 24px rgba(146, 132, 102, 0.12);
}

@media (prefers-reduced-motion: reduce) {
  .${CLASS.shimmer},
  .${CLASS.pulseGold},
  .${CLASS.slideInRight},
  .${CLASS.fadeScaleIn},
  .${CLASS.hoverLift},
  .${CLASS.press} {
    animation: none !important;
    transition: none !important;
  }
  .${CLASS.hoverLift}:hover {
    transform: none !important;
  }
}
`;

/**
 * Inject the animations stylesheet into document.head exactly once.
 * Safe to call from app bootstrap.
 */
export function ensureAnimationsInjected(): void {
  if (typeof document === "undefined") return;
  const id = "jellyclaw-animations";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = ANIMATIONS_CSS;
  document.head.appendChild(style);
}
