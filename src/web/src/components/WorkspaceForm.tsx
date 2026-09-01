import * as React from "react";
import { useId, useState, type FormEvent } from "react";

import type {
  PublicSandboxConfig,
  WorkspaceSecurityProfile,
  WorkspaceSessionStorage,
} from "../../../shared/protocol.js";

export interface WorkspaceFormValues {
  readonly name: string;
  readonly path: string;
  readonly sessionStorage: WorkspaceSessionStorage;
  readonly securityProfile: WorkspaceSecurityProfile;
}

export interface WorkspaceFormInitialValues extends WorkspaceFormValues {
  readonly effectiveSecurityProfile: WorkspaceSecurityProfile | null;
}

export interface WorkspaceFormProps {
  readonly mode: "create" | "edit";
  readonly initialValues?: WorkspaceFormInitialValues;
  readonly publicSandboxConfig: PublicSandboxConfig;
  /** A live runtime makes path/profile changes server-invalid; name remains editable. */
  readonly securityControlsLocked: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onSubmit: (values: WorkspaceFormValues) => Promise<void>;
  readonly onCancel: () => void;
}

export function securityProfileLabel(profile: WorkspaceSecurityProfile): string {
  return profile === "workspace-sandboxed" ? "Workspace sandbox" : "Unrestricted";
}

function createProfile(config: PublicSandboxConfig): WorkspaceSecurityProfile {
  return config.mode === "required" ? "workspace-sandboxed" : "unrestricted";
}

/** Explicit name/path/security form shared by workspace creation and editing. */
export function WorkspaceForm({
  mode,
  initialValues,
  publicSandboxConfig,
  securityControlsLocked,
  submitting,
  error,
  onSubmit,
  onCancel,
}: WorkspaceFormProps) {
  const formId = useId().replaceAll(":", "");
  const editing = mode === "edit";
  const [name, setName] = useState(initialValues?.name ?? "");
  const [path, setPath] = useState(initialValues?.path ?? "");
  const [sessionStorage, setSessionStorage] = useState<WorkspaceSessionStorage>(
    initialValues?.sessionStorage ?? "pi-default",
  );
  const initialProfile = initialValues?.securityProfile ?? createProfile(publicSandboxConfig);
  // Required mode overrides existing rows without rewriting their stored value.
  // Disabled mode offers only unrestricted; saving a formerly sandboxed row is
  // therefore an explicit, confirmed downgrade in the sidebar.
  const [securityProfile, setSecurityProfile] = useState<WorkspaceSecurityProfile>(
    publicSandboxConfig.mode === "disabled"
      ? "unrestricted"
      : publicSandboxConfig.mode === "required" && !editing
        ? "workspace-sandboxed"
        : initialProfile,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleError = validationError ?? error;
  const profileSelectable = publicSandboxConfig.mode === "optional";
  const pathLocked = editing && securityControlsLocked;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = {
      name: name.trim(),
      path: path.trim(),
      sessionStorage,
      securityProfile,
    };
    if (values.name.length === 0) {
      setValidationError("Enter a workspace name.");
      return;
    }
    if (values.path.length === 0) {
      setValidationError("Enter the full path to an existing directory.");
      return;
    }
    setValidationError(null);
    await onSubmit(values);
  }

  return (
    <form
      className="workspace-form"
      aria-label={editing ? "Edit workspace" : "Create workspace"}
      onSubmit={(event) => void submit(event)}
    >
      <h3>{editing ? "Edit workspace" : "Add workspace"}</h3>
      <label htmlFor={`${formId}-name`}>Name</label>
      <input
        id={`${formId}-name`}
        autoFocus
        value={name}
        disabled={submitting}
        autoComplete="off"
        aria-invalid={visibleError !== null}
        aria-describedby={visibleError === null ? undefined : `${formId}-error`}
        onChange={(event) => {
          setName(event.target.value);
          setValidationError(null);
        }}
      />
      <label htmlFor={`${formId}-path`}>Directory path</label>
      <input
        id={`${formId}-path`}
        value={path}
        disabled={submitting || pathLocked}
        spellCheck={false}
        autoComplete="off"
        placeholder="/full/path/to/project"
        aria-invalid={visibleError !== null}
        aria-describedby={visibleError === null ? undefined : `${formId}-error`}
        onChange={(event) => {
          setPath(event.target.value);
          setValidationError(null);
        }}
      />
      <p className="workspace-form-help">
        {pathLocked
          ? "Close this workspace’s live conversations before changing its directory or security profile."
          : "The server must be able to read and search this directory."}
      </p>

      {profileSelectable ? (
        <>
          <label htmlFor={`${formId}-security`}>Security profile</label>
          <select
            id={`${formId}-security`}
            value={securityProfile}
            disabled={submitting || securityControlsLocked}
            onChange={(event) => {
              setSecurityProfile(event.target.value as WorkspaceSecurityProfile);
              setValidationError(null);
            }}
          >
            {publicSandboxConfig.selectableProfiles.map((profile) => (
              <option key={profile} value={profile}>{securityProfileLabel(profile)}</option>
            ))}
          </select>
        </>
      ) : (
        <>
          <span className="workspace-field-label" id={`${formId}-security-label`}>Security profile</span>
          <div
            className="workspace-profile-fixed"
            aria-labelledby={`${formId}-security-label`}
          >
            {securityProfileLabel(
              publicSandboxConfig.mode === "required"
                ? "workspace-sandboxed"
                : securityProfile,
            )}
          </div>
        </>
      )}
      {editing && initialValues !== undefined && (
        <dl className="workspace-profile-summary">
          <div>
            <dt>Stored profile</dt>
            <dd>{securityProfileLabel(initialValues.securityProfile)}</dd>
          </div>
          <div>
            <dt>Effective profile</dt>
            <dd>{initialValues.effectiveSecurityProfile === null
              ? "None — policy blocked"
              : securityProfileLabel(initialValues.effectiveSecurityProfile)}</dd>
          </div>
        </dl>
      )}
      {publicSandboxConfig.mode === "required" && (
        <p className="workspace-form-help">The server requires Workspace sandbox for every runtime.</p>
      )}
      {publicSandboxConfig.mode === "disabled" && initialValues?.securityProfile === "workspace-sandboxed" && (
        <p className="workspace-form-warning">
          Sandboxing is disabled. Saving changes the stored profile to Unrestricted after confirmation.
        </p>
      )}

      {!editing && (
        <label className="workspace-storage-option" htmlFor={`${formId}-storage`}>
          <input
            id={`${formId}-storage`}
            type="checkbox"
            checked={sessionStorage === "workspace"}
            disabled={submitting}
            onChange={(event) => {
              setSessionStorage(
                event.target.checked ? "workspace" : "pi-default",
              );
            }}
          />
          <span>Store sessions in this workspace</span>
        </label>
      )}
      {visibleError !== null && (
        <p className="form-error" id={`${formId}-error`} role="alert">{visibleError}</p>
      )}
      <div className="form-actions">
        <button type="button" disabled={submitting} onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? (editing ? "Saving…" : "Adding…") : (editing ? "Save changes" : "Add workspace")}
        </button>
      </div>
    </form>
  );
}
