# Conversation revision and command response semantics

The server owns each conversation's revision. A newly registered conversation starts at revision `0`. Revisions are non-negative safe integers and never reset during that live conversation.

## What increments a revision

The registry increments the revision exactly once, before broadcasting, for every externally visible conversation event:

- message start, text/thinking delta, and message completion;
- tool start, update, and completion;
- queue changes;
- status transitions;
- retry, compaction, and runtime notices; and
- metadata or runtime replacement changes represented by a new authoritative state snapshot, including title, model, session identity/file, CWD, or durability changes.

One normalized event gets one revision even if applying it changes several fields. Events are emitted in revision order. A runtime replacement increments once after the replacement is complete; the resulting state snapshot carries that new revision.

These operations do **not** increment the revision:

- reading/opening an already-live conversation or requesting a snapshot;
- listing or broadcasting history;
- updating internal LRU/access bookkeeping;
- a rejected command; or
- an idempotent request that produces no state change, such as aborting an already idle conversation.

Snapshots report the current revision and do not increment it merely because they were requested. Successive snapshots can therefore have the same revision. A persisted session reopened after being closed is a new live projection and starts at revision `0`; clients replace their old projection with the open response.

## Client reconciliation

For an event with revision `incoming` and a local revision `current`:

- `incoming === current + 1`: apply the event and set the local revision;
- `incoming <= current`: ignore it as stale or duplicate; and
- `incoming > current + 1` (or an invalid revision): do not apply it and request `conversation.state`.

A complete snapshot with an equal or newer revision replaces local conversation state. An older snapshot is an out-of-order response and is ignored. If there is no local projection, the snapshot is accepted. Reconnect and conversation selection always use a full snapshot rather than replaying deltas.

The shared helpers in `src/shared/revisions.ts` implement these rules.

## Successful command responses

Every command produces one correlated success response, or one correlated `error`. Commands are correlated by `requestId`.

| Command | Success response |
|---|---|
| `history.list` | `history` |
| `conversation.create` | `state` for the new conversation |
| `conversation.open` | `state` for the opened or already-live conversation |
| `conversation.state` | authoritative `state` |
| `conversation.close` | `ack` |
| `conversation.delete` | `ack` |
| `conversation.fork` | `state` for the new fork, with required `editorText` |
| `prompt.submit` | immediate acceptance `ack` |
| `prompt.steer` | immediate acceptance `ack` |
| `prompt.followUp` | immediate acceptance `ack` |
| `conversation.abort` | `ack` |

Prompt acknowledgements mean that the server accepted the operation, not that the model run succeeded. Later model failures are conversation events/state. History changes caused by create, close, delete, fork, or title derivation are separate uncorrelated `history` broadcasts.

The `CommandSuccessByType` type in `src/shared/protocol.ts` encodes this table.
