import * as React from "react";
import { useId, useState, type FormEvent } from "react";

import type { WorkspaceSessionStorage } from "../../../shared/protocol.js";

export interface WorkspaceFormValues {
  readonly name: string;
  readonly path: string;
  readonly sessionStorage: WorkspaceSessionStorage;
}

export interface WorkspaceFormProps {
  readonly mode: "create" | "edit";
  readonly initialValues?: WorkspaceFormValues;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onSubmit: (values: WorkspaceFormValues) => Promise<void>;
  readonly onCancel: () => void;
}

/** Explicit name/path form shared by workspace creation and editing. */
export function WorkspaceForm({
  mode,
  initialValues,
  submitting,
  error,
  onSubmit,
  onCancel,
}: WorkspaceFormProps) {
  const formId = useId().replaceAll(":", "");
  const [name, setName] = useState(initialValues?.name ?? "");
  const [path, setPath] = useState(initialValues?.path ?? "");
  const [sessionStorage, setSessionStorage] = useState<WorkspaceSessionStorage>(
    initialValues?.sessionStorage ?? "pi-default",
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const visibleError = validationError ?? error;
  const editing = mode === "edit";

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = {
      name: name.trim(),
      path: path.trim(),
      sessionStorage,
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
        disabled={submitting}
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
        The server must be able to read and search this directory.
      </p>
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
