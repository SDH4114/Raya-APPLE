#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${RAYA_REPO_URL:-https://github.com/SDH4114/Raya-APPLE.git}"
REPO_REF="${RAYA_REPO_REF:-prime}"
NODE_MAJOR="${RAYA_NODE_MAJOR:-22}"
NVM_COMMIT="977563e97ddc66facf3a8e31c6cff01d236f09bd"
NVM_INSTALL_SHA256="2d8359a64a3cb07c02389ad88ceecd43f2fa469c06104f92f98df5b6f315275f"
raya_state_dir="${RAYA_HOME:-$HOME/.raya}"
preserve_raya_state=0
raya_was_installed=0
legacy_update_checkpoint=0
if command -v raya >/dev/null 2>&1; then
  raya_was_installed=1
fi
if [ "$raya_was_installed" -eq 1 ] && [ "${RAYA_UPDATE_CHECKPOINT_CREATED:-0}" != "1" ]; then
  # Raya 0.1.3 and older do not pass the checkpoint marker yet. Create the
  # recovery point here so those clients can upgrade safely to this installer.
  legacy_update_checkpoint=1
fi
if [ "${RAYA_UPDATE_MODE:-0}" = "1" ] || [ -e "$raya_state_dir" ] || [ "$raya_was_installed" -eq 1 ]; then
  preserve_raya_state=1
fi

case "$(uname -s)" in
  Darwin|Linux) ;;
  *)
    echo "Raya installer supports macOS and Linux only." >&2
    exit 1
    ;;
esac

need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  current_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$current_major" -lt "$NODE_MAJOR" ]; then
    need_node=1
  fi
fi

if [ "$need_node" -eq 1 ]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Node.js via nvm." >&2
    exit 1
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "Installing nvm..."
    nvm_installer="$(mktemp)"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_COMMIT/install.sh" -o "$nvm_installer"
    if command -v sha256sum >/dev/null 2>&1; then
      nvm_digest="$(sha256sum "$nvm_installer" | awk '{print $1}')"
    else
      nvm_digest="$(shasum -a 256 "$nvm_installer" | awk '{print $1}')"
    fi
    if [ "$nvm_digest" != "$NVM_INSTALL_SHA256" ]; then
      rm -f "$nvm_installer"
      echo "nvm installer checksum verification failed." >&2
      exit 1
    fi
    NVM_INSTALL_VERSION="$NVM_COMMIT" bash "$nvm_installer"
    rm -f "$nvm_installer"
  fi

  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MAJOR"
  nvm use "$NODE_MAJOR"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found after Node.js setup." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install Raya from GitHub." >&2
  exit 1
fi

ensure_raya_on_path() {
  local raya_executable="$1"
  local path_entry

  case ":$PATH:" in
    *":$npm_global_bin:"*)
      return
      ;;
  esac

  # `curl | bash` cannot modify the parent shell's PATH. Put a launcher in a
  # writable directory that is already on PATH so `raya` works immediately in
  # the terminal that ran the installer.
  local old_ifs="$IFS"
  IFS=":"
  for path_entry in $PATH; do
    [ -n "$path_entry" ] || continue
    [ "${path_entry#/}" != "$path_entry" ] || continue
    if [ -d "$path_entry" ] && [ -w "$path_entry" ]; then
      ln -sf "$raya_executable" "$path_entry/raya"
      IFS="$old_ifs"
      return
    fi
  done
  IFS="$old_ifs"

  # There was no writable PATH entry. Preserve a dependable launcher and make
  # it available to future zsh/bash sessions. The current parent shell cannot
  # be changed by a piped installer, so state the one required refresh clearly.
  local fallback_bin="$HOME/.local/bin"
  mkdir -p "$fallback_bin"
  ln -sf "$raya_executable" "$fallback_bin/raya"

  local shell_file
  for shell_file in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$shell_file" ] && ! grep -Fqx 'export PATH="$HOME/.local/bin:$PATH"' "$shell_file"; then
      printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$shell_file"
    fi
  done

  echo "Added Raya to $fallback_bin." >&2
  echo "Open a new terminal or run: export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
}

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

echo "Downloading Raya from $REPO_URL#$REPO_REF..."
if [[ "$REPO_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  git init "$tmpdir/raya"
  git -C "$tmpdir/raya" remote add origin "$REPO_URL"
  git -C "$tmpdir/raya" fetch --depth 1 origin "$REPO_REF"
  git -C "$tmpdir/raya" checkout --detach FETCH_HEAD
else
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmpdir/raya"
fi

cd "$tmpdir/raya"
npm ci --ignore-scripts
npm run build
# Installing a directory globally can create a link back to this temporary
# checkout. Install the packed archive instead, because the checkout is removed
# by the EXIT trap when this script finishes.
package_tarball="$(npm pack --ignore-scripts --pack-destination "$tmpdir" | tail -n 1)"

create_legacy_update_checkpoint() {
  local installed_root current_version target_version backup_root base_name checkpoint checkpoint_number created_at old_archive
  installed_root="$(npm root -g)/@sdh4114/raya"
  if [ ! -d "$installed_root" ]; then
    echo "Could not locate the currently installed Raya package for the update checkpoint." >&2
    exit 1
  fi

  current_version="$(node -p "require('$installed_root/package.json').version")"
  target_version="$(node -p "require('./package.json').version")"
  backup_root="${RAYA_BACKUP_ROOT:-$HOME/raya-backups}"
  mkdir -p "$backup_root"

  case "$backup_root/" in
    "$raya_state_dir/"*|"$raya_state_dir")
      echo "RAYA_BACKUP_ROOT must be outside RAYA_HOME: $backup_root" >&2
      exit 1
      ;;
  esac

  created_at="$(date -u +%Y%m%dT%H%M%SZ)"
  base_name="update-${current_version}-to-${target_version}-${created_at}"
  checkpoint="$backup_root/$base_name"
  checkpoint_number=2
  while ! mkdir "$checkpoint" 2>/dev/null; do
    checkpoint="$backup_root/${base_name}-${checkpoint_number}"
    checkpoint_number=$((checkpoint_number + 1))
  done

  # npm pack reproduces the installed package without copying its dependency
  # tree. The state copy includes credentials because this is a local recovery
  # point, just like the normal Raya update checkpoint.
  old_archive="$(npm pack --ignore-scripts --pack-destination "$checkpoint" "$installed_root" | tail -n 1)"
  if [ ! -f "$checkpoint/$old_archive" ]; then
    echo "Could not package the currently installed Raya for the update checkpoint." >&2
    exit 1
  fi
  mv "$checkpoint/$old_archive" "$checkpoint/raya-package.tgz"
  if [ -e "$raya_state_dir" ]; then
    cp -R "$raya_state_dir" "$checkpoint/.raya"
  else
    mkdir -p "$checkpoint/.raya"
  fi
  printf '{\n  "id": "%s",\n  "name": "Before update v%s to v%s",\n  "createdAt": "%s",\n  "rayaVersion": "%s",\n  "mode": "local",\n  "secretsIncluded": true,\n  "kind": "update-checkpoint",\n  "targetVersion": "%s"\n}\n' \
    "$base_name" "$current_version" "$target_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$current_version" "$target_version" \
    > "$checkpoint/manifest.json"
  echo "Created compatibility checkpoint: $checkpoint"
}

if [ "$legacy_update_checkpoint" -eq 1 ]; then
  create_legacy_update_checkpoint
  export RAYA_UPDATE_CHECKPOINT_CREATED=1
fi

npm install -g --ignore-scripts "$tmpdir/$package_tarball"

npm_global_bin="$(npm prefix -g)/bin"
raya_executable="$npm_global_bin/raya"
if [ ! -x "$raya_executable" ]; then
  echo "Raya was installed, but its executable was not found at $raya_executable." >&2
  exit 1
fi

ensure_raya_on_path "$raya_executable"
if [ "$preserve_raya_state" -eq 1 ]; then
  echo "Preserved existing Raya state at $raya_state_dir."
else
  "$raya_executable" skills sync

  # Loading Raya during the first-run sync creates the user-owned default
  # personality only when it is missing. Keep installation honest: a successful
  # fresh installer must leave this file ready before the user starts Raya.
  if [ ! -f "$raya_state_dir/SOUL.md" ]; then
    echo "Raya initialization did not create $raya_state_dir/SOUL.md." >&2
    exit 1
  fi
fi

echo
echo "Raya installed."
echo "Next steps:"
echo "  raya login"
echo "  raya"
