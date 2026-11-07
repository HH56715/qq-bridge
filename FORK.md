# Fork notice

This repository is **upstream qq-bridge, tag `v0.2.1-r1`, plus one added package**.

- Upstream: [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge), commit
  `a49877f4e58d04e47532d44b803360d0f001160d` (2026-10-22), the release published under the MIT license.
- Added here: `plugins/qq-persona-switch/` — a DeepSeek Harness plugin, and this file.
- Removed here: `_snowluma-catalog.json`, a local dump of SnowLuma's tool catalog that upstream
  itself dropped in v0.2.1-r2. Nothing references it.
- Everything else is byte-identical to that tag.

Upstream has since moved on to v0.2.2-rc1 under **PolyForm Noncommercial 1.0.0**; none of those
later changes are included here, so this tree stays MIT (see `LICENSE`, copyright Derpyu520 and
qq-bridge / QSH contributors).

## The added package

qq-bridge already has persona cards (`roles/<name>.md`, injected into every prompt, `/role` to
switch). If you also run
[dsh-persona-dafeiyu](https://github.com/huaizhuanghub/dsh-persona-dafeiyu), that plugin injects
its own persona section when a DSH session is assembled. Turning both on means two personas
mixed into one reply, with no way to tell which one is live — and the bridge offers no switch
for the other side.

`plugins/qq-persona-switch` lists both sides in one place and makes picking one turn the other
off explicitly. It talks to qq-bridge's existing HTTP API (`/api/roles`, `/api/role`,
`/api/status`) and to dsh-persona-dafeiyu's local API; nothing in the bridge source is patched
to support it.

```bash
dsh plugin --profile web add github:suisen123/qq-bridge#path:/plugins/qq-persona-switch
```

Requires a running qq-bridge (its console port) and, for the second half of the list,
dsh-persona-dafeiyu installed. See `plugins/qq-persona-switch/README.md`.

## Not included

This tree does **not** carry the local extensions of the deployment it came from: no
`mcp-media` / `mcp-skills` / `mcp-qq-extra` servers, no extra skill packages, no SD-image or
TTS wiring, no extra persona cards. They are unrelated to the plugin and stay unpublished.

## License

MIT, inherited from the upstream tag (see `LICENSE`). The added package is MIT as well and
carries its own copy at `plugins/qq-persona-switch/LICENSE`.