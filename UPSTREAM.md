# Upstream

This repository is a copy of **qq-bridge v0.2.1-r1**, with one package added under
`plugins/qq-persona-switch/`.

- Upstream: [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), commit
  `a49877f4e58d04e47532d44b803360d0f001160d` (2026-10-22), released under the MIT license.
- Added: `plugins/qq-persona-switch/` — a DeepSeek Harness plugin. It uses qq-bridge's existing
  HTTP API and `state/` files; no bridge source is patched to support it.
- Removed: `_snowluma-catalog.json`, a stale snapshot of SnowLuma's tool catalog that upstream
  itself dropped in v0.2.1-r2. Nothing references it.
- The rest is upstream's, unchanged.

Later upstream releases are published under **PolyForm Noncommercial 1.0.0**; none of those
changes are included here, so this tree stays under the MIT license in `LICENSE`.

The plugin has its own README at `plugins/qq-persona-switch/README.md` and its own copy of the
license at `plugins/qq-persona-switch/LICENSE`.