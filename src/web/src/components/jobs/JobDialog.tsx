import { useId, type RefObject } from "react";

import type { JobSummary, PublicJobsConfig } from "../../../../shared/jobs.js";
import type { PublicManagedEgressConfig, WorkspaceSummary } from "../../../../shared/protocol.js";
import { Modal } from "../Modal.js";
import { JobForm, type JobFormValues } from "./JobForm.js";

export interface JobDialogProps {
  readonly job?: JobSummary | undefined;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly config: PublicJobsConfig;
  readonly managedEgressConfig: PublicManagedEgressConfig;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly onSubmit: (values: JobFormValues) => Promise<void>;
  readonly onClose: () => void;
}

export function JobDialog(props: JobDialogProps) {
  const titleId = `job-dialog-${useId().replaceAll(":", "")}-title`;
  return (
    <Modal labelledBy={titleId} returnFocusRef={props.returnFocusRef} closeDisabled={props.submitting} className="job-dialog" onClose={props.onClose}>
      <JobForm
        {...(props.job === undefined ? {} : { job: props.job })}
        workspaces={props.workspaces}
        config={props.config}
        managedEgressConfig={props.managedEgressConfig}
        submitting={props.submitting}
        error={props.error}
        titleId={titleId}
        onSubmit={props.onSubmit}
        onCancel={props.onClose}
      />
    </Modal>
  );
}
