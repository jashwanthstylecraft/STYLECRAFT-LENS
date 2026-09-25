"use client";

// Was a GSAP-driven effect layer (mouse-tracking spotlight/glow, particle
// bursts, tilt, magnetism, click ripple) wrapping real tab content across
// the app — removed for performance (continuous mousemove listeners + DOM
// particle churn on every card-bearing page) and simplicity. Kept as a
// plain passthrough (same props/children shape) so call sites across the
// dashboard don't need their own changes; every card now just renders with
// its normal solid background/border (.magic-bento-card in MagicBento.css).
import type { ReactNode } from "react";

export interface MagicBentoCardProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  glowColor?: string;
  enableStars?: boolean;
  enableBorderGlow?: boolean;
  enableTilt?: boolean;
  enableMagnetism?: boolean;
  clickEffect?: boolean;
  particleCount?: number;
  disableAnimations?: boolean;
  onClick?: () => void;
}

export function MagicBentoCard({ children, className = "", style, onClick }: MagicBentoCardProps) {
  return (
    <div onClick={onClick} className={`magic-bento-card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function MagicBentoSection({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
  enableSpotlight?: boolean;
  spotlightRadius?: number;
  glowColor?: string;
}) {
  return <div className={`magic-bento-section ${className}`}>{children}</div>;
}
