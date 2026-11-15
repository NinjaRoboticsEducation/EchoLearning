#!/usr/bin/env bash
set -euo pipefail

repo=https://github.com/NinjaRoboticsEducation/EchoLearning.git
destination="${1:-$PWD/EchoLearning}"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The installer currently supports macOS." >&2
  exit 1
fi
for dependency in git brew; do
  command -v "$dependency" >/dev/null || { echo "Install $dependency before continuing." >&2; exit 1; }
done

parent="$(cd "$(dirname "$destination")" && pwd -P)"
destination="$parent/$(basename "$destination")"
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "Destination already exists: $destination" >&2
  exit 1
fi
lock="$destination.install-lock"
mkdir "$lock"
stage=""
cleanup() {
  if [[ -n "$stage" ]]; then rm -rf "$stage"; fi
  rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage="$(mktemp -d "$parent/.echolearning-install.XXXXXX")"
git clone --depth 1 "$repo" "$stage"
commit="$(git -C "$stage" rev-parse HEAD)"
echo "Installing EchoLearning at $commit. Models require approximately 9 GB of download space."
"$stage/scripts/setup.sh"
# Virtual environments contain absolute paths and must be recreated after publication.
rm -rf "$stage/adk_backend/.venv"
printf '%s\n' "$commit" > "$stage/.installed-commit"
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "Destination appeared during installation: $destination" >&2
  exit 1
fi
mv "$stage" "$destination"
stage=""
printf 'Installed in %s\nStart with %s/scripts/start.sh\n' "$destination" "$destination"
