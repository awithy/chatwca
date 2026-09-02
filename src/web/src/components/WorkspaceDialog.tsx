import * as React from "react";
import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

import type {
  PublicManagedEgressConfig,
  PublicSandboxConfig,
} from "../../../shared/protocol.js";
import {
  WorkspaceForm,
  type WorkspaceFormInitialValues,
  type WorkspaceFormValues,
} from "./WorkspaceForm.js";

export interface WorkspaceDialogProps {
  readonly mode: "create" | "edit";
  readonly initialValues?: WorkspaceFormInitialValues;
  readonly publicSandboxConfig: PublicSandboxConfig;
  readonly publicManagedEgressConfig: PublicManagedEgressConfig;
  readonly securityControlsLocked: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onSubmit: (values: WorkspaceFormValues) => Promise<void>;
  readonly onClose: () => void;
}

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** A portal-backed modal shell shared by workspace creation and editing. */
export function WorkspaceDialog({
  mode,
  initialValues,
  publicSandboxConfig,
  publicManagedEgressConfig,
  securityControlsLocked,
  submitting,
  error,
  returnFocusRef,
  onSubmit,
  onClose,
}: WorkspaceDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `workspace-dialog-${useId().replaceAll(":", "")}-title`;

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("#root");
    const previousOverflow = document.body.style.overflow;
    const previouslyInert = root?.inert ?? false;
    if (root !== null) root.inert = true;
    document.body.style.overflow = "hidden";

    const frame = window.requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>(
        "[aria-invalid='true']:not([disabled]), [data-initial-focus]:not([disabled]), input:not([disabled]), select:not([disabled]), button:not([disabled])",
      );
      target?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (root !== null) root.inert = previouslyInert;
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [returnFocusRef]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!submitting) onClose();
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
    <div className="workspace-dialog-backdrop">
      <div
        ref={dialogRef}
        className="workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <WorkspaceForm
          mode={mode}
          {...(initialValues === undefined ? {} : { initialValues })}
          titleId={titleId}
          publicSandboxConfig={publicSandboxConfig}
          publicManagedEgressConfig={publicManagedEgressConfig}
          securityControlsLocked={securityControlsLocked}
          submitting={submitting}
          error={error}
          onSubmit={onSubmit}
          onCancel={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}
