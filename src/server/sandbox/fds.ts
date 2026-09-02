/**
 * Process descriptor assignments shared by the Bubblewrap builders, helper
 * launcher, probe, and worker transport. Keep these values synchronized with
 * native/network-helper/src/protocol.rs.
 */
export const SANDBOX_FDS = Object.freeze({
  helperLaunch: 3,
  helperReady: 4,
  helperInnerConfig: 7,
  workerRequest: 8,
  workerResponse: 9,
  helperHttpBootstrap: 10,
  helperSocksBootstrap: 11,
  helperSelfArtifact: 12,
  managedArtifacts: Object.freeze({
    worker: 13,
    passwd: 14,
    group: 15,
    hosts: 16,
    nsswitch: 17,
  }),
  isolatedArtifacts: Object.freeze({
    worker: 3,
    passwd: 4,
    group: 5,
    hosts: 6,
    nsswitch: 7,
  }),
});

export const SANDBOX_REQUEST_FD = SANDBOX_FDS.workerRequest;
export const SANDBOX_RESPONSE_FD = SANDBOX_FDS.workerResponse;
export const ISOLATED_SANDBOX_STDIO_COUNT = SANDBOX_RESPONSE_FD + 1;
export const MANAGED_SANDBOX_STDIO_COUNT = SANDBOX_FDS.managedArtifacts.nsswitch + 1;

const managedAssignments = [
  SANDBOX_FDS.helperLaunch,
  SANDBOX_FDS.helperReady,
  SANDBOX_FDS.helperInnerConfig,
  SANDBOX_FDS.workerRequest,
  SANDBOX_FDS.workerResponse,
  SANDBOX_FDS.helperHttpBootstrap,
  SANDBOX_FDS.helperSocksBootstrap,
  SANDBOX_FDS.helperSelfArtifact,
  ...Object.values(SANDBOX_FDS.managedArtifacts),
];
if (new Set(managedAssignments).size !== managedAssignments.length) {
  throw new Error("managed sandbox descriptor assignments overlap");
}
