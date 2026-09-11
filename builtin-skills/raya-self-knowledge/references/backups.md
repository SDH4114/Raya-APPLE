# Raya Backup, Restore, and Uninstall

## Commands

- `raya backup --setup`: choose GitHub or Local and save the target without creating a backup immediately.
- First unconfigured `raya backup`: run setup, ask for a backup name, then create it.
- Configured `raya backup`: ask for a name and create a backup in the configured mode.
- `raya backup --local <name>`: configure Local mode and create that named backup without the name prompt.
- `raya backup --github <repository>`: configure and verify a GitHub repository, then ask for the backup name unless `--name` is supplied.
- `raya backup --list` and typo-compatible `raya bakcup --list`: print separate GitHub and Local sections with backup name, Raya version, creation date, and restore command.
- `raya backup --restore [name-or-reference]`: always ask `GitHub` or `Local`, even when a reference was supplied, then require the exact word `RESTORE`.
- `raya update`: after confirmation, require a complete local update checkpoint before installation. If checkpoint creation fails, abort without installing.
- `raya uninstall`: require the exact word `UNINSTALL`, remove the package, launchers, `RAYA_HOME`, and local backup root. `--keep-backups` preserves the local backup root. Remote repositories are never deleted.

## Local Layout

Every new local backup is exactly one direct child of the backup root:

```text
~/raya-backups/
├── before-upgrade/
│   ├── .raya/
│   ├── src/
│   ├── builtin-skills/
│   ├── package.json
│   ├── manifest.json
│   └── raya-package.tgz
└── after-upgrade/
    ├── .raya/
    ├── src/
    ├── builtin-skills/
    ├── package.json
    ├── manifest.json
    └── raya-package.tgz
```

The source tree keeps its natural folders, but there is no extra date directory, `snapshot`, `snapshots`, `backups`, `raya-source`, `raya-home`, or `.git` wrapper around it. The backup name becomes the folder name after safe path normalization. A duplicate folder name fails instead of replacing an existing backup. If creation fails, Raya removes the incomplete named folder.

Local backups include the complete `.raya` state, including `.env` and `auth.json`, so the backup root must remain private.

## Update Checkpoints and State Isolation

Each confirmed update creates a unique local `update-<current>-to-<target>-<timestamp>` sibling folder even when ordinary backups are unconfigured or configured for GitHub. Its manifest uses `kind: update-checkpoint` and records the target version. Checkpoints are never silently replaced; a same-timestamp collision receives a numeric suffix.

The checkpoint must finish before the installer starts. The updater passes the exact checked Git SHA as `RAYA_REPO_REF`, marks the completed checkpoint, and gives the installer a disposable temporary `RAYA_HOME`. For older Raya clients that do not pass the checkpoint marker, the installer creates a compatibility checkpoint from the currently installed package and `.raya` before replacement. It also skips state initialization in update mode or whenever existing state is present. Consequently an update does not create, overwrite, migrate, synchronize, or delete any path inside the user's `.raya`. Normal later startup may install a missing built-in skill, but it still preserves every existing user-owned skill folder.

The updater downloads `install.ps1` and runs it through PowerShell on Windows; macOS and Linux continue to use `install.sh` through Bash. Both paths receive the same pinned commit, checkpoint marker, update-mode marker, and disposable `RAYA_HOME`. Fresh Unix installation verifies the pinned nvm installer before execution, and every package install/restore disables npm lifecycle scripts. Windows backup and restore package operations invoke `npm.cmd`, and uninstall recognizes only npm-owned `raya.cmd`/`raya.ps1` shims before removing state.

## GitHub Layout and Lifetime

GitHub mode does not create or retain a repository under `~/raya-backups`. Create, list, and restore each clone the configured repository into a temporary system directory and remove that checkout in a `finally` cleanup path, including when an operation fails.

Raya changes only `.raya-backup` in the remote repository. The remote snapshot contains `raya-source`, `raya-home`, `manifest.json`, and `raya-package.tgz`. `.env` and `auth.json` are excluded. Literal MCP credentials in JSON `headers` and `env` fields are recursively removed, exact `${ENV_VAR}` references are retained, and malformed JSON aborts the remote backup instead of being copied unsanitized. Sessions, memory, configuration, and personality files can still be personal, so the repository should be private.

GitHub versions are remote Git commits. Listing reads their manifests from remote history; restore checks out the selected commit temporarily and never turns it into a persistent local backup.

## Configuration

The typed `backup` object in `~/.raya/config.json` stores the active mode, display name, setup time, and either the local backup root or sanitized repository URL. `RAYA_BACKUP_TARGET` in owner-only `~/.raya/.env` mirrors the exact target. Updates must merge with the existing config and preserve unknown fields.

## Restore and Compatibility

`--restore` always asks for the source first. It then resolves the supplied name/reference within that source, asks for `RESTORE`, installs `raya-package.tgz` with npm lifecycle scripts disabled, and restores state. GitHub restores preserve existing local credentials because remote snapshots intentionally omit them.

New local backups use only the flat named-folder layout. Discovery and restore remain compatible with older `snapshots/<id>` layouts and the earlier local-Git history format; compatibility must not be used when creating new backups.
