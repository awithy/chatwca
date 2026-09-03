import * as React from "react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface ModalProps {
  readonly labelledBy: string;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly closeDisabled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}

/** Portal-backed modal with focus containment, inert background, and restoration. */
export function Modal({
  labelledBy,
  returnFocusRef,
  closeDisabled = false,
  className = "",
  children,
  onClose,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("#root");
    const previousOverflow = document.body.style.overflow;
    const previouslyInert = root?.inert ?? false;
    if (root !== null) root.inert = true;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(
        "[aria-invalid='true']:not([disabled]), [data-initial-focus]:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
      )?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (root !== null) root.inert = previouslyInert;
      document.body.style.overflow = previousOverflow;
      returnFocusRef?.current?.focus();
    };
  }, [returnFocusRef]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!closeDisabled) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return createPortal(
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
