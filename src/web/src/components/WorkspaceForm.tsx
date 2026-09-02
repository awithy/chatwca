import * as React from "react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  MAX_WORKSPACE_MOUNTS,
  WORKSPACE_MOUNT_NAME_PATTERN,
  workspaceMountGuestPath,
} from "../../../shared/protocol.js";
import type {
  PublicManagedEgressConfig,
  PublicNetworkPolicySet,
  PublicSandboxConfig,
  SandboxNetworkPolicy,
  WorkspaceMount,
  WorkspaceNetworkPolicyIssue,
  WorkspaceSecurityProfile,
  WorkspaceSessionStorage,
} from "../../../shared/protocol.js";

export interface WorkspaceFormValues {
  readonly name: string;
  readonly path: string;
  readonly sessionStorage: WorkspaceSessionStorage;
  readonly securityProfile: WorkspaceSecurityProfile;
  readonly mounts: readonly WorkspaceMount[];
  readonly networkPolicy: SandboxNetworkPolicy;
  readonly networkPolicySetId: string;
}

export interface WorkspaceFormInitialValues extends WorkspaceFormValues {
  readonly effectiveSecurityProfile: WorkspaceSecurityProfile | null;
  readonly effectiveNetworkPolicy: SandboxNetworkPolicy | null;
  readonly effectiveNetworkPolicySetId: string | null;
  readonly networkPolicyIssue: WorkspaceNetworkPolicyIssue;
}

export interface WorkspaceFormProps {
  readonly mode: "create" | "edit";
  readonly initialValues?: WorkspaceFormInitialValues;
  readonly titleId?: string;
  readonly publicSandboxConfig: PublicSandboxConfig;
  readonly publicManagedEgressConfig: PublicManagedEgressConfig;
  /** A live runtime makes path/profile/network/set changes server-invalid; name remains editable. */
  readonly securityControlsLocked: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly onSubmit: (values: WorkspaceFormValues) => Promise<void>;
  readonly onCancel: () => void;
}

export function securityProfileLabel(profile: WorkspaceSecurityProfile): string {
  return profile === "workspace-sandboxed" ? "Workspace sandbox" : "Unrestricted";
}

export function networkPolicyLabel(policy: SandboxNetworkPolicy): string {
  return policy === "managed-egress" ? "Managed egress" : "Isolated";
}

export function networkPolicyIssueText(issue: WorkspaceNetworkPolicyIssue): string {
  switch (issue) {
    case "managed_egress_disabled":
      return "Managed egress is disabled by the administrator.";
    case "managed_egress_policy_set_unavailable":
      return "The stored destination policy is no longer available. Select a replacement or switch to Isolated.";
    case null:
      return "No network policy issue";
  }
}

function createProfile(config: PublicSandboxConfig): WorkspaceSecurityProfile {
  return config.mode === "required" ? "workspace-sandboxed" : "unrestricted";
}

function defaultPolicySet(config: PublicManagedEgressConfig): PublicNetworkPolicySet {
  return config.policySets.find(({ id }) => id === "default") ?? config.policySets[0]!;
}

function setLabel(set: PublicNetworkPolicySet | undefined, id: string): string {
  return set === undefined ? `${id} — unavailable` : `${set.label} (${set.id})`;
}

/** Explicit name/path/security form shared by workspace creation and editing. */
export function WorkspaceForm({
  mode,
  initialValues,
  titleId,
  publicSandboxConfig,
  publicManagedEgressConfig,
  securityControlsLocked,
  submitting,
  error,
  onSubmit,
  onCancel,
}: WorkspaceFormProps) {
  const formId = useId().replaceAll(":", "");
  const editing = mode === "edit";
  const nameRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialValues?.name ?? "");
  const [path, setPath] = useState(initialValues?.path ?? "");
  const [sessionStorage, setSessionStorage] = useState<WorkspaceSessionStorage>(
    initialValues?.sessionStorage ?? "pi-default",
  );
  const initialProfile = initialValues?.securityProfile ?? createProfile(publicSandboxConfig);
  const [securityProfile, setSecurityProfile] = useState<WorkspaceSecurityProfile>(
    publicSandboxConfig.mode === "disabled"
      ? "unrestricted"
      : publicSandboxConfig.mode === "required" && !editing
        ? "workspace-sandboxed"
        : initialProfile,
  );
  const [mounts, setMounts] = useState<readonly WorkspaceMount[]>(
    initialValues?.mounts ?? [],
  );
  const [networkPolicy, setNetworkPolicy] = useState<SandboxNetworkPolicy>(
    initialValues?.networkPolicy ?? "isolated",
  );
  const [networkPolicySetId, setNetworkPolicySetId] = useState(
    initialValues?.networkPolicySetId ?? defaultPolicySet(publicManagedEgressConfig).id,
  );
  const [validationError, setValidationError] = useState<{
    readonly field: "name" | "path" | "mounts";
    readonly message: string;
  } | null>(null);
  const visibleError = validationError?.message ?? error;
  const profileSelectable = publicSandboxConfig.mode === "optional";
  const pathLocked = editing && securityControlsLocked;
  const sandboxNetworkRelevant = securityProfile === "workspace-sandboxed" ||
    initialValues?.effectiveSecurityProfile === "workspace-sandboxed";
  const networkPolicySelectable = publicManagedEgressConfig.selectablePolicies.length > 1 ||
    !publicManagedEgressConfig.selectablePolicies.includes(networkPolicy);
  const destinationPolicyRelevant = securityProfile === "workspace-sandboxed" &&
    networkPolicy === "managed-egress";
  const selectedSet = publicManagedEgressConfig.policySets.find(({ id }) => id === networkPolicySetId);
  const storedSet = initialValues === undefined
    ? undefined
    : publicManagedEgressConfig.policySets.find(({ id }) => id === initialValues.networkPolicySetId);
  const errorId = `${formId}-error`;
  const pathHelpId = `${formId}-path-help`;
  const networkHelpId = `${formId}-network-help`;
  const setHelpId = `${formId}-set-help`;

  useEffect(() => {
    if (validationError?.field === "name") nameRef.current?.focus();
    if (validationError?.field === "path") pathRef.current?.focus();
  }, [validationError]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = {
      name: name.trim(),
      path: path.trim(),
      sessionStorage,
      securityProfile,
      mounts: mounts.map((mount) => ({ ...mount, name: mount.name.trim(), source: mount.source.trim() })),
      networkPolicy,
      networkPolicySetId,
    };
    if (values.name.length === 0) {
      setValidationError({ field: "name", message: "Enter a workspace name." });
      return;
    }
    if (values.path.length === 0) {
      setValidationError({ field: "path", message: "Enter the full path to an existing directory." });
      return;
    }
    const mountNames = new Set<string>();
    let invalidMount = false;
    for (const mount of values.mounts) {
      if (
        !new RegExp(WORKSPACE_MOUNT_NAME_PATTERN, "u").test(mount.name) ||
        mountNames.has(mount.name) || mount.source.length === 0 || !mount.source.startsWith("/")
      ) invalidMount = true;
      mountNames.add(mount.name);
    }
    if (invalidMount) {
      setValidationError({
        field: "mounts",
        message: "Each mount needs a unique lowercase name and an absolute server directory path.",
      });
      return;
    }
    setValidationError(null);
    await onSubmit(values);
  }

  const sharedErrorDescription = visibleError === null ? undefined : errorId;

  return (
    <form
      className="workspace-form"
      aria-label={editing ? "Edit workspace" : "Create workspace"}
      aria-describedby={error === null ? undefined : errorId}
      onSubmit={(event) => void submit(event)}
    >
      <h3 id={titleId}>{editing ? "Edit workspace" : "Add workspace"}</h3>
      <label htmlFor={`${formId}-name`}>Name</label>
      <input
        ref={nameRef}
        id={`${formId}-name`}
        data-initial-focus
        value={name}
        disabled={submitting}
        autoComplete="off"
        aria-invalid={validationError?.field === "name" || (error !== null ? true : undefined)}
        aria-describedby={validationError?.field === "name" || error !== null ? errorId : undefined}
        onChange={(event) => {
          setName(event.target.value);
          setValidationError(null);
        }}
      />
      <label htmlFor={`${formId}-path`}>Directory path</label>
      <input
        ref={pathRef}
        id={`${formId}-path`}
        value={path}
        disabled={submitting || pathLocked}
        spellCheck={false}
        autoComplete="off"
        placeholder="/full/path/to/project"
        aria-invalid={validationError?.field === "path" || (error !== null ? true : undefined)}
        aria-describedby={[pathHelpId, validationError?.field === "path" || error !== null ? errorId : null]
          .filter(Boolean).join(" ")}
        onChange={(event) => {
          setPath(event.target.value);
          setValidationError(null);
        }}
      />
      <p className="workspace-form-help" id={pathHelpId}>
        {pathLocked
          ? "Close this workspace’s live conversations before changing its directory, filesystem mounts, security profile, network type, or destination policy."
          : "The server must be able to read and search this directory."}
      </p>

      {profileSelectable ? (
        <>
          <label htmlFor={`${formId}-security`}>Security profile</label>
          <select
            id={`${formId}-security`}
            value={securityProfile}
            disabled={submitting || securityControlsLocked}
            aria-describedby={sharedErrorDescription}
            onChange={(event) => {
              const profile = event.target.value as WorkspaceSecurityProfile;
              setSecurityProfile(profile);
              if (!editing && profile !== "workspace-sandboxed") {
                setNetworkPolicy("isolated");
                setMounts([]);
              }
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
          <div className="workspace-profile-fixed" aria-labelledby={`${formId}-security-label`}>
            {securityProfileLabel(publicSandboxConfig.mode === "required" ? "workspace-sandboxed" : securityProfile)}
          </div>
        </>
      )}
      {sandboxNetworkRelevant && (
        <>
          <label htmlFor={`${formId}-network`}>Sandbox network</label>
          {networkPolicySelectable ? (
            <select
              id={`${formId}-network`}
              value={networkPolicy}
              disabled={submitting || securityControlsLocked}
              aria-describedby={`${networkHelpId}${sharedErrorDescription === undefined ? "" : ` ${sharedErrorDescription}`}`}
              onChange={(event) => {
                setNetworkPolicy(event.target.value as SandboxNetworkPolicy);
                setValidationError(null);
              }}
            >
              {!publicManagedEgressConfig.selectablePolicies.includes(networkPolicy) && (
                <option value={networkPolicy} disabled>{networkPolicyLabel(networkPolicy)} — unavailable</option>
              )}
              {publicManagedEgressConfig.selectablePolicies.map((policy) => (
                <option key={policy} value={policy}>{networkPolicyLabel(policy)}</option>
              ))}
            </select>
          ) : (
            <div id={`${formId}-network`} className="workspace-profile-fixed" aria-label="Sandbox network">
              {networkPolicyLabel(networkPolicy)}
            </div>
          )}
          <p className="workspace-form-help" id={networkHelpId}>
            {networkPolicy === "managed-egress"
              ? "Tools may contact only destinations in the selected administrator-defined policy."
              : "Tools have no network access."}
          </p>
        </>
      )}
      {destinationPolicyRelevant && (
        <section className="destination-policy-control">
          <label id={`${formId}-set-label`} htmlFor={`${formId}-set`}>Destination policy</label>
          <select
            id={`${formId}-set`}
            value={networkPolicySetId}
            disabled={submitting || securityControlsLocked}
            aria-describedby={`${setHelpId}${sharedErrorDescription === undefined ? "" : ` ${sharedErrorDescription}`}`}
            onChange={(event) => {
              setNetworkPolicySetId(event.target.value);
              setValidationError(null);
            }}
          >
            {selectedSet === undefined && (
              <option value={networkPolicySetId} disabled>{setLabel(undefined, networkPolicySetId)}</option>
            )}
            {publicManagedEgressConfig.policySets.map((set) => (
              <option key={set.id} value={set.id}>{setLabel(set, set.id)}</option>
            ))}
          </select>
          <p className="workspace-form-help" id={setHelpId}>
            Policies are administrator-defined. Destinations are disclosed below and cannot be edited here.
          </p>
          {selectedSet === undefined ? (
            <p className="workspace-form-warning" role="status">
              The stored destination policy “{networkPolicySetId}” is unavailable. Select a replacement or switch to Isolated.
            </p>
          ) : (
            <dl className="destination-policy-disclosure">
              <div>
                <dt>Allowed domains</dt>
                <dd>{selectedSet.allowedDomainPatterns.map((pattern) => <code key={pattern}>{pattern}</code>)}</dd>
              </div>
              <div>
                <dt>Allowed TCP ports</dt>
                <dd>{selectedSet.allowedPorts.join(", ") || "None"}</dd>
              </div>
            </dl>
          )}
        </section>
      )}
      {sandboxNetworkRelevant && (
        <fieldset
          className="workspace-mounts-control"
          disabled={submitting || securityControlsLocked}
          aria-describedby={validationError?.field === "mounts" ? errorId : undefined}
        >
          <legend>Additional filesystem mounts</legend>
          <p className="workspace-form-help">
            Existing server directories are exposed under <code>/mounts/&lt;name&gt;</code>. These paths may contain sensitive host data.
          </p>
          {mounts.map((mount, index) => (
            <div className="workspace-mount-row" key={index}>
              <label htmlFor={`${formId}-mount-name-${String(index)}`}>Mount name</label>
              <input
                id={`${formId}-mount-name-${String(index)}`}
                value={mount.name}
                spellCheck={false}
                autoComplete="off"
                placeholder="shared-data"
                onChange={(event) => {
                  const name = event.target.value;
                  setMounts((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name } : item
                  ));
                  setValidationError(null);
                }}
              />
              <label htmlFor={`${formId}-mount-source-${String(index)}`}>Server directory</label>
              <input
                id={`${formId}-mount-source-${String(index)}`}
                value={mount.source}
                spellCheck={false}
                autoComplete="off"
                placeholder="/srv/shared/data"
                onChange={(event) => {
                  const source = event.target.value;
                  setMounts((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, source } : item
                  ));
                  setValidationError(null);
                }}
              />
              <label htmlFor={`${formId}-mount-access-${String(index)}`}>Access</label>
              <select
                id={`${formId}-mount-access-${String(index)}`}
                value={mount.access}
                onChange={(event) => {
                  const access = event.target.value as WorkspaceMount["access"];
                  setMounts((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, access } : item
                  ));
                  setValidationError(null);
                }}
              >
                <option value="read-only">Read-only</option>
                <option value="read-write">Read-write</option>
              </select>
              <div className="workspace-mount-destination">
                Guest path: <code>{workspaceMountGuestPath(mount.name || "name")}</code>
              </div>
              <button
                type="button"
                className="workspace-mount-remove"
                onClick={() => setMounts((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              >
                Remove mount
              </button>
            </div>
          ))}
          <button
            type="button"
            className="workspace-mount-add"
            disabled={submitting || securityControlsLocked || mounts.length >= MAX_WORKSPACE_MOUNTS}
            onClick={() => {
              let sequence = mounts.length + 1;
              while (mounts.some(({ name }) => name === `mount-${String(sequence)}`)) sequence += 1;
              setMounts((current) => [...current, {
                name: `mount-${String(sequence)}`,
                source: "",
                access: "read-only",
              }]);
            }}
          >
            Add mount
          </button>
          {mounts.some(({ access }) => access === "read-write") && (
            <p className="workspace-form-warning">
              Read-write mounts let sandboxed tools modify files outside the workspace.
            </p>
          )}
        </fieldset>
      )}
      {editing && initialValues !== undefined && (
        <dl className="workspace-profile-summary">
          <div><dt>Stored profile</dt><dd>{securityProfileLabel(initialValues.securityProfile)}</dd></div>
          <div><dt>Effective profile</dt><dd>{initialValues.effectiveSecurityProfile === null ? "None — policy blocked" : securityProfileLabel(initialValues.effectiveSecurityProfile)}</dd></div>
          <div><dt>Stored network type</dt><dd>{networkPolicyLabel(initialValues.networkPolicy)}</dd></div>
          <div><dt>Effective network type</dt><dd>{initialValues.effectiveNetworkPolicy === null ? "None" : networkPolicyLabel(initialValues.effectiveNetworkPolicy)}</dd></div>
          <div><dt>Stored destination policy</dt><dd>{setLabel(storedSet, initialValues.networkPolicySetId)}</dd></div>
          <div><dt>Effective destination policy</dt><dd>{initialValues.effectiveNetworkPolicySetId === null ? "None" : setLabel(publicManagedEgressConfig.policySets.find(({ id }) => id === initialValues.effectiveNetworkPolicySetId), initialValues.effectiveNetworkPolicySetId)}</dd></div>
          <div className="workspace-profile-summary-wide"><dt>Network policy issue</dt><dd>{networkPolicyIssueText(initialValues.networkPolicyIssue)}</dd></div>
        </dl>
      )}
      {publicSandboxConfig.mode === "required" && (
        <p className="workspace-form-help">The server requires Workspace sandbox for every runtime.</p>
      )}
      {publicSandboxConfig.mode === "disabled" && initialValues?.securityProfile === "workspace-sandboxed" && (
        <p className="workspace-form-warning">Sandboxing is disabled. Saving changes the stored profile to Unrestricted after confirmation.</p>
      )}
      {!editing && (
        <label className="workspace-storage-option" htmlFor={`${formId}-storage`}>
          <input
            id={`${formId}-storage`}
            type="checkbox"
            checked={sessionStorage === "workspace"}
            disabled={submitting}
            aria-describedby={sharedErrorDescription}
            onChange={(event) => setSessionStorage(event.target.checked ? "workspace" : "pi-default")}
          />
          <span>Store sessions in this workspace</span>
        </label>
      )}
      {visibleError !== null && <p className="form-error" id={errorId} role="alert">{visibleError}</p>}
      <div className="form-actions">
        <button type="button" disabled={submitting} onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="submit" disabled={submitting}>
          {submitting ? (editing ? "Saving…" : "Adding…") : (editing ? "Save changes" : "Add workspace")}
        </button>
      </div>
    </form>
  );
}
