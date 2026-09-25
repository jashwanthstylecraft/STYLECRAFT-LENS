"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/ui";

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ModalPlacement = "center" | "right" | "top";
export type ModalSize = "sm" | "md" | "lg" | "xl";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  placement?: ModalPlacement;
  size?: ModalSize;
  className?: string;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

const CONTAINER_CLASSES: Record<ModalPlacement, string> = {
  center: "items-center justify-center p-4",
  right: "items-center justify-end",
  top: "items-start justify-center pt-[15vh] px-4",
};

// The single shared overlay shell — owns backdrop-click-to-close, Escape-key
// handling, and focus trapping, so individual modals (AddCompetitorModal,
// LinkReportModal, Shell's command palette) only need to supply their own
// header/body/footer content. No open/close animation (removed app-wide for
// simplicity/performance) — renders or doesn't, plainly.
export function Modal({ isOpen, onClose, children, placement = "center", size = "md", className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Escape-to-close (existing behavior, unchanged).
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  // Focus management: move focus INTO the panel on open (remembering
  // whatever triggered it), trap Tab/Shift+Tab within the panel's own
  // focusable elements while open, and return focus to the trigger on
  // close — none of this existed before, so every modal in the app
  // (search palette, AddCompetitorModal, ConfirmDialog, ContactSupportModal,
  // LinkReportModal, ...) shares this one fix.
  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const focusFirst = () => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panelRef.current)?.focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 z-50 flex", CONTAINER_CLASSES[placement])}>
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full shadow-2xl outline-none",
          placement === "right"
            ? "h-screen bg-surface-2 border-l border-border flex flex-col"
            : "bg-surface-2 border border-border rounded-xl flex flex-col",
          SIZE_CLASSES[size],
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}
