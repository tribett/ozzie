# Public export from a private source repository

Status: accepted by owner, 2026-11-13.

Ozzie is developed in a private repository, which stays the source of truth:
it also holds planning, research, build evidence, agent working rules and
business decisions that are not for publication. The open-source app and core
are published to a separate public repository as a **fresh-history export**:
each release is a filtered copy of the private repository's committed tree
with its own new history, never a mirror of private history.

The whole public repository, core and desktop app alike, is **Apache-2.0**.
This extends ADR 0004 from `core/` to the app. Paid offerings are managed
services only (the hosted model route, accounts, setup and support). The open
app works with the user's own model key or a local model, and no safety
behaviour may exist only in the private repository.

The export (`tools/public-export/` in the private repository) is default-deny:

- It copies only paths matched by an explicit allowlist, from the committed
  HEAD tree, never untracked or uncommitted files. An allowlist line that
  matches nothing fails the export.
- It writes the public LICENSE (full Apache-2.0 text), NOTICE and README.
- It fails if any relative import, Rust include or module, Cargo path
  dependency, page asset or package script points outside the exported tree,
  so a private change cannot publish a partial app.
- It runs a safety scan that fails on any hit: credential shapes and
  gitleaks; values from the private environment file; company email
  addresses; absolute local paths; references to other private repositories;
  agent-process artefacts (evidence and log files, worktree paths, session
  links); environment and key files, symlinks, and unexpected binaries. A
  self-test with planted hits runs first, so a broken scan cannot pass
  silently. Company mentions other than the attribution
  "Ozzie by FlockConnect", the owner's name, and references to unpublished
  documents are listed for a person to review.
- It creates one commit and never adds a remote or pushes. Creating the public
  repository and pushing to it remain owner steps.

The first allowlist exports the desktop app, the browser walkthrough with
invented data, the core modules the apps import, the safety primitives ADR
0004 places in core, the Rust crate `core/native-auth`, their tests with fixed
fictional data, and a few documents (the never-list, the Planning Center read
contract, and ADRs 0002, 0004 and 0005). Runtime and host experiments the app
does not use stay private until they are needed.

Consequences: changes are made in the private repository and reach the public
one only through a new export, so outside contributions must be ported back
by hand. Files must be fixed at the source, never edited in the export. A
safety fix counts as shipped only when it is in an export.
