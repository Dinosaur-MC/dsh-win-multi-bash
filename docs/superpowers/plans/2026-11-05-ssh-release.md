# ssh_shell 0.8.0 — hosts GUI, release gate and release (Plan 4)

## Goal

Finish 0.8.0: the hosts table GUI, the migration/release docs and the spec/plan
amendments, the mandatory isolated-DSH boot gate, then the release itself (push,
CI, tag, GitHub release, npm) — the release only after the gate passes and the
human rules on the release.

## Non-negotiables

- The hosts table is a real editor of `sshShell.hosts`: add/remove rows, edit
  every field, at most one `default` (zero allowed), per-host `approval` select, save through
  the existing form; no JSON text remains on the Configure page.
- The client form renderer stays a generated-registry consumer; no new slot, no
  page navigation; dictionary values are strings; README under 10k.
- Version 0.8.0: `package.json`, lockfile, RELEASE_NOTES (a real section), and
  the docs version guards move together. No tag/push/npm before the gate.
- Spec/plan amendments (docs/superpowers): ssh_list deferred to a later release
  with §18.1 rewritten (aliases are visible in the alias parameter), ssh2 pinned
  `~1.17.0` (deliberate deviation from `^1.17.0`), the 22-port bracket-negation
  over-refusal documented, the >1-default error may list aliases, Task 8's
  coverage rationale, the slow-dial deadline observation, and the Plan 4 boot
  gate.
- MANDATORY RELEASE GATE (isolated DSH): isolated `DSH_HOME` + local plugin
  install + a model provider + a local sshd host with `approval: session` + a
  browser over CDP. Open an `ssh_shell` approval: the dedicated card renders
  and answers `allowed-once`/`rejected`; a non-ssh approval still uses the
  platform card. Additional checks: sequential approvals through the same
  composer instance reset their state (key by pending id) and a synchronous
  throw from `pending.answer` re-enables the buttons and shows the error.
  Failure blocks 0.8.0.
- Push/tag/GitHub release/npm need the human's explicit ruling after the gate;
  CI must be green before the tag (red CI = no release).

## Tasks

### Task 1 — hosts table GUI

- Replace the JSON-text renderer for `kind: 'hosts'` in `lib/client.js` with a
  table/list editor: one row per host, fields alias/host/port/user/keyPath/
  passphraseEnv/startupCommand/shellTemplate/connectTimeoutMs/approval/
  acceptNewHostKeys/default/description; add row, remove row, move? (no), mark
  default as a radio (at most one; zero allowed), approval as a select; invalid rows show the
  field error inline; the value saved is the array of host objects.
- Keep the existing form plumbing (coerce/sameValue/invalidReason/dictionary);
  no JSON text fallback visible; a "raw JSON" escape hatch is allowed only if
  the table is the default (decide and document).
- Audit: add/remove/edit saves the right array; default exclusivity; approval
  select; blank optional fields cleared; invalid alias/port shows the error;
  generated registry still byte-equal; no navigation; a11y labels.

### Task 2 — migration, release docs, spec/plan amendments

- Product docs: the 0.8.0 migration (ssh_bash -> ssh_shell, sshBash ->
  sshShell, single-host pin -> hosts, terminal pins), the release notes
  section, the hosts table description, the release gate/known limitations
  (lexical local path, no MaxSessions retry beyond the bounded budget, ssh_list
  deferred, terminal does not read the registry).
- Spec/plan amendments as listed above, in docs/superpowers (archival but
  accurate).
- Keep README <10k; i18n together; version guards updated with Task 3.

### Task 3 — 0.8.0 version and notes

- Bump package.json to 0.8.0, refresh package-lock, add the RELEASE_NOTES
  section (rename, hosts, known_hosts, pool/exec, jobs, scp, authorization,
  retry, hosts GUI, migration, known limitations, breaking changes).
- Update the docs version guard and the audit note/version assertions.
- Audit + npm test green on a clean tree.

### Task 4 — mandatory isolated-DSH boot gate

- Run the gate described above; capture evidence (DOM/screenshot + the
  sequential-approval and sync-throw checks). If the environment cannot express
  it (no provider, no sshd, no browser), record exactly what is missing and do
  NOT release; the gate is a release blocker, not a docs note.
- Check the two Plan 3 E2E items: sequential approvals reset state; a
  synchronous `pending.answer` throw re-enables/shows the error.

### Task 5 — release (human ruling required)

- Push feat/ssh-shell (or a release branch) after the human's ruling; wait for
  CI green; tag v0.8.0 (lightweight, per the repo convention); GitHub release
  body cut from the RELEASE_NOTES section and byte-checked; npm publish; verify
  npm latest and the release body.
- No release if the gate failed or CI is red.

## Acceptance

- Hosts table works end-to-end on the Configure page (no JSON text; add/remove/
  edit/default/approval; save).
- Docs and spec/plan are accurate; version 0.8.0 everywhere.
- The boot gate passes with captured evidence, or 0.8.0 is not released.
- CI green before tag; release body byte-identical to the notes; npm published.
