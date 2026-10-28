# ADR 0007 — MIT license; documentation-as-tiles methodology

- **Status:** Accepted (2026-10-28)

## Context

SI-Thor is an open-source organization. The business is **technicians installing
hardware with adaptable software, customized per client**. That model only works if the
reasoning behind every path taken — and every path *not* taken — is durable and
discoverable. As the owner put it: another use case might be more optimized for one of
our ideas that wasn't best for our install; "these tiles of knowledge become seeds for
exploration and understanding later."

## Decision

1. **Code: MIT.** Maximally adaptable — technicians and clients can reshape installs
   without license friction.
2. **Model weights are not ours to license.** Every engine's weight license is recorded
   in the daemon's voice registry metadata; installers filter by client requirements.
   Nothing model-derived is redistributed from this repo (`.gitignore` excludes weights
   and audio artifacts by default).
3. **Methodology: tiles.**
   - Decisions → ADRs, never deleted, superseded in place.
   - Verified facts → dated research notes with links (fast-moving ecosystem; facts are
     true *as of* their date).
   - Ideas considered but not taken → `docs/ideas/` backlog with status and
     "fits-elsewhere" notes — explicitly preserved for other installs.
   - Commits: early and often, messages explain why; reversals are new commits with
     reasons, never history rewrites.

## Consequences

- A future maintainer (human or agent) can reconstruct not just *what* skald is but
  *what it could have been* — and which alternative was one client-requirement away.
- Adds a documentation tax on every change; accepted deliberately, because it is the
  product as much as the code is.
