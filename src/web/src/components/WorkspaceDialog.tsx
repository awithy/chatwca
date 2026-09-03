import * as React from "react";
import { useId, type RefObject } from "react";

import type {
  PublicManagedEgressConfig,
  PublicSandboxConfig,
} from "../../../shared/protocol.js";
import { Modal } from "./Modal.js";
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
  const titleId = `workspace-dialog-${useId().replaceAll(":", "")}-title`;
  return (
    <Modal
      labelledBy={titleId}
      returnFocusRef={returnFocusRef}
      closeDisabled={submitting}
      className="workspace-dialog"
      onClose={onClose}
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
    </Modal>
  );
}
