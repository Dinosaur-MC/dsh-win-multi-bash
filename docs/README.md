# Documentation

The [README](../README.md) is the entry point and release summary. These documents carry the detail the README deliberately leaves out.

| Document | Covers |
| --- | --- |
| [Architecture](architecture.md) | Rows, executors, the dialect registry, the tool factory, the prompt section, the client half, the call flow, and path conversion |
| [Design principles](principles.md) | The rules the implementation is held to — what the plugin may assert, how surfaces are derived, and where it deliberately diverges |
| [Sandbox behavior](sandbox.md) | Per-backend capabilities, Windows caveats, bwrap setup, the self-heal switch, and SSH's remote scope |
| [Terminal sessions](terminal.md) | PTY lifecycle, signals, output bounds, sessions vs jobs, SSH sessions, measured defaults |
| [Conversation rows](conversation-rows.md) | How a call becomes the platform's own shell card |
| [Configuration](configuration.md) | The Plugins page, every row's knobs, live semantics, staged saves |
| [Verification](verification.md) | Dev runtime, both test entries, the audit gate, the live SSH round trip |
| [Troubleshooting](troubleshooting.md) | Symptom → fix |

These documents are maintained in English. The bilingual README (`README.md` / `README.zh.md`) is the release-facing summary and is kept consistent by the audit (both sides are recorded in `README.i18n.yaml`).

Repository-only material (`docs/`, `smoke/`) is not part of the published npm tarball; `package.json`'s `files` whitelist decides what ships.
