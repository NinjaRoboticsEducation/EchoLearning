#!/usr/bin/env bash
set -euo pipefail
trap 'echo "❌ EchoLearning installation failed at line $LINENO (command: $BASH_COMMAND)." >&2' ERR

repo="${ECHO_REPO_URL:-https://github.com/NinjaRoboticsEducation/EchoLearning.git}"
BRANCH_NAME="${ECHO_REPO_BRANCH:-}"
SETUP_ARGS=()
DEST_ARG=""

usage() {
  cat <<'EOF'
EchoLearning Automated Installer (macOS)

Usage:
  ./scripts/install.sh [OPTIONS] [DESTINATION]
  curl -fsSL https://raw.githubusercontent.com/NinjaRoboticsEducation/EchoLearning/HEAD/scripts/install.sh | bash -s -- [OPTIONS] [DESTINATION]

Options:
  --branch <branch>             Git branch to clone (or set ECHO_REPO_BRANCH)
  --non-interactive, --default  Use default/recommended model (Qwen3.5-9B-Q6_K) without prompting
  --models <list>               Comma-separated model IDs or menu numbers (e.g. "1,3" or "qwen3.5-4b-q6_k")
  -h, --help                    Show this help message and exit

Arguments:
  DESTINATION                   Target directory (default: ./EchoLearning, or current directory if already inside EchoLearning)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --branch)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "❌ Error: --branch requires a branch name." >&2
        exit 1
      fi
      BRANCH_NAME="$2"
      shift 2
      ;;
    --non-interactive|--default)
      SETUP_ARGS+=("--non-interactive")
      shift
      ;;
    --models)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "❌ Error: --models requires a model list." >&2
        exit 1
      fi
      SETUP_ARGS+=("--models" "$2")
      shift 2
      ;;
    -*)
      echo "❌ Error: Unknown option '$1'. Run with --help for usage." >&2
      exit 1
      ;;
    *)
      if [[ -z "$DEST_ARG" ]]; then
        DEST_ARG="$1"
        shift
      else
        echo "❌ Error: Unexpected positional argument '$1'." >&2
        exit 1
      fi
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ The EchoLearning installer currently supports macOS." >&2
  exit 1
fi

if ! pwd -P >/dev/null 2>&1; then
  if [[ -n "$DEST_ARG" && "$DEST_ARG" == /* ]]; then
    cd "$HOME"
  else
    echo "❌ Your current terminal directory no longer exists (likely removed by uninstall.sh)." >&2
    echo "   Please run 'cd ..' (or 'cd ~') first, then re-run the installer." >&2
    exit 1
  fi
fi

if [[ -n "$DEST_ARG" ]]; then
  destination="$DEST_ARG"
elif [[ -d "$PWD/adk_backend" && -f "$PWD/scripts/setup.sh" ]]; then
  destination="$PWD"
else
  destination="$PWD/EchoLearning"
fi

parent_raw="$(dirname "$destination")"
mkdir -p "$parent_raw"
parent="$(cd "$parent_raw" && pwd -P)"
destination="$parent/$(basename "$destination")"

echo "================================================================================"
echo "  EchoLearning — Automated Installer (macOS)"
echo "  Repository : $repo${BRANCH_NAME:+ (branch: $BRANCH_NAME)}"
echo "  Destination: $destination"
echo "================================================================================"

if ! command -v git >/dev/null 2>&1; then
  echo "❌ 'git' is required but not installed. Install Xcode Command Line Tools (xcode-select --install) or Homebrew git." >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "❌ Homebrew is required but not installed. Install it from https://brew.sh/ and re-run." >&2
  exit 1
fi

BRANCH_ARGS=()
if [[ -n "$BRANCH_NAME" ]]; then
  BRANCH_ARGS=("--branch" "$BRANCH_NAME")
fi

if [[ -f "$destination/scripts/setup.sh" ]]; then
  echo "✓ Found existing EchoLearning directory at $destination — continuing with setup and model installation..."
elif [[ -e "$destination" || -L "$destination" ]]; then
  if [[ -d "$destination" && ! -L "$destination" && -z "$(ls -A "$destination" 2>/dev/null || true)" ]]; then
    echo "Cloning EchoLearning into empty directory $destination..."
    git clone --depth 1 ${BRANCH_ARGS[@]+"${BRANCH_ARGS[@]}"} "$repo" "$destination"
  else
    echo "❌ Destination already exists and is not an EchoLearning repository: $destination" >&2
    echo "   Choose a different target directory or remove the existing path first." >&2
    exit 1
  fi
else
  echo "Cloning EchoLearning into $destination..."
  git clone --depth 1 ${BRANCH_ARGS[@]+"${BRANCH_ARGS[@]}"} "$repo" "$destination"
fi

IS_NON_INTERACTIVE=0
for arg in ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}; do
  if [[ "$arg" == "--non-interactive" ]]; then
    IS_NON_INTERACTIVE=1
    break
  fi
done

cd "$destination"
if [[ "$IS_NON_INTERACTIVE" -eq 0 ]] && ( : < /dev/tty ) 2>/dev/null; then
  "$destination/scripts/setup.sh" ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"} < /dev/tty
else
  "$destination/scripts/setup.sh" ${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}
fi

git -C "$destination" rev-parse HEAD > "$destination/.installed-commit" 2>/dev/null || true

echo ""
echo "================================================================================"
echo "🎉 EchoLearning Installation Complete!"
echo "  Location: $destination"
echo "  To start EchoLearning:"
echo "    cd \"$destination\""
echo "    ./scripts/start_all.sh"
echo "================================================================================
"
