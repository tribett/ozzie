# Core licence and safety placement

Superseded in part by [ADR 0005](0005-public-export.md) (2026-11-13): the desktop app and core are both
Apache-2.0 and are published as a fresh-history public repository.

Status: accepted by owner, 2026-10-29.

`core/` is licensed **Apache-2.0** (patent and trademark language suits a
church-trust open core; compatible with the Tauri/Pi/Hermes upstreams).
Publication timing is deferred: nothing publishes until the owner sets a
date, and no code may be written assuming a different licence.

Safety primitives belong in `core/`, publishable without the product
layer: authorization broker, egress placeholder boundary, deterministic
findings engine, approval-gate and audit (What happened) primitives, and
task ledger. The product layer keeps presentation only. No safety
behaviour may exist solely in the paid or product layer.
