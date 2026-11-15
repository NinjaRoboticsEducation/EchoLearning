#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RAW_PROJECT_ROOT="${ECHO_UNINSTALL_ROOT:-$DEFAULT_ROOT}"

DRY_RUN=false
NON_INTERACTIVE=false
AUTO_YES=false
MODE="" # "all" | "deps-only" | ""
KEEP_DATA=false
KEEP_MODELS=false
REMOVE_BREW=false
REMOVE_APP_DIR=false
BACKUP_DIR=""

usage() {
  cat <<'EOF'
EchoLearning Uninstaller & Disk Cleanup

Usage:
  ./uninstall.sh [OPTIONS]
  ./scripts/uninstall.sh [OPTIONS]

Options:
  -h, --help                 Show this help message and exit
  --dry-run                  Preview every action without stopping services or deleting files
  -y, --yes                  Skip confirmation prompts
  --non-interactive          Run without interactive prompts (requires --all or --deps-only)
  --deps-only                Remove Python .venv, node_modules, dist, logs, .pids, .pytest_cache
                             (preserves models/ and data/)
  --all                      Remove dependencies, build caches, models/, and data/
                             (respects --keep-data and --keep-models)
  --keep-data                Preserve data/ (echolearning.sqlite3 and data/audio/)
  --keep-models              Preserve models/ (*.gguf, *.bin, manifest.json)
  --brew                     Also uninstall Homebrew llama.cpp and whisper-cpp
                             (never removes shared tools: ffmpeg, node, python)
  --backup-dir <dir>         Archive data/ to <dir>/echolearning-study-backup-<timestamp>.tar.gz
                             before removing data/
  --remove-app-dir           Remove the EchoLearning project directory itself after cleanup
  --project-root <dir>       Target EchoLearning directory (or set ECHO_UNINSTALL_ROOT)

Examples:
  ./uninstall.sh
      Launch the interactive cleanup & uninstall wizard.

  ./uninstall.sh --dry-run --all
      Preview disk space savings and actions without deleting anything.

  ./uninstall.sh --all --keep-data
      Free AI model and dependency space while keeping your vocabulary and shadowing history.

  ./uninstall.sh --all --backup-dir ~/Desktop --brew --remove-app-dir
      Back up study data to Desktop, remove everything including llama.cpp/whisper-cpp, and
      delete the EchoLearning folder.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -y|--yes)
      AUTO_YES=true
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
      ;;
    --deps-only)
      MODE="deps-only"
      shift
      ;;
    --all)
      MODE="all"
      shift
      ;;
    --keep-data)
      KEEP_DATA=true
      shift
      ;;
    --keep-models)
      KEEP_MODELS=true
      shift
      ;;
    --brew)
      REMOVE_BREW=true
      shift
      ;;
    --remove-app-dir)
      REMOVE_APP_DIR=true
      shift
      ;;
    --backup-dir)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --backup-dir requires a directory path." >&2
        exit 1
      fi
      BACKUP_DIR="$2"
      shift 2
      ;;
    --project-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Error: --project-root requires a directory path." >&2
        exit 1
      fi
      RAW_PROJECT_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown option '$1'. Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Safety Guard: Validate Target Project Root
# ---------------------------------------------------------------------------

if [[ -z "$RAW_PROJECT_ROOT" || ! -d "$RAW_PROJECT_ROOT" ]]; then
  echo "Error: Target project root does not exist: ${RAW_PROJECT_ROOT:-<empty>}" >&2
  exit 1
fi

PROJECT_ROOT="$(cd "$RAW_PROJECT_ROOT" && pwd -P)"
RESOLVED_HOME=""
if [[ -n "${HOME:-}" && -d "${HOME:-}" ]]; then
  RESOLVED_HOME="$(cd "$HOME" && pwd -P)"
fi

for forbidden in "/" "/System" "/usr" "/bin" "/sbin" "/etc" "/var" "/Applications" "/Volumes"; do
  if [[ "$PROJECT_ROOT" == "$forbidden" ]]; then
    echo "Safety Error: Refusing to operate on protected system path '$PROJECT_ROOT'." >&2
    exit 1
  fi
done

if [[ -n "$RESOLVED_HOME" && "$PROJECT_ROOT" == "$RESOLVED_HOME" ]]; then
  echo "Safety Error: Refusing to operate directly on HOME directory '$PROJECT_ROOT'." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_ROOT/adk_backend" && ! -f "$PROJECT_ROOT/scripts/start.sh" && ! -f "$PROJECT_ROOT/package.json" ]]; then
  echo "Safety Error: '$PROJECT_ROOT' does not look like an EchoLearning directory." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Disk Usage Helpers
# ---------------------------------------------------------------------------

measure_paths_usage() {
  local existing=()
  local p
  for p in "$@"; do
    if [[ -e "$p" ]]; then
      existing+=("$p")
    fi
  done
  if [[ ${#existing[@]} -eq 0 ]]; then
    echo "0B (not present)"
    return 0
  fi
  if [[ ${#existing[@]} -eq 1 ]]; then
    du -sh "${existing[0]}" 2>/dev/null | awk '{print $1}'
  else
    du -shc "${existing[@]}" 2>/dev/null | tail -n 1 | awk '{print $1}'
  fi
}

collect_model_paths() {
  local results=()
  local prev_nullglob
  prev_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local f
  for f in "$PROJECT_ROOT/models/"*.gguf "$PROJECT_ROOT/models/"*.bin "$PROJECT_ROOT/models/"*.tmp "$PROJECT_ROOT/models/manifest.json"; do
    [[ -e "$f" ]] && results+=("$f")
  done
  eval "$prev_nullglob"
  printf '%s\n' "${results[@]+"${results[@]}"}"
}

collect_data_paths() {
  local results=()
  local prev_nullglob
  prev_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local f
  for f in "$PROJECT_ROOT/data/echolearning.sqlite3"* "$PROJECT_ROOT/data/audio"; do
    [[ -e "$f" ]] && results+=("$f")
  done
  eval "$prev_nullglob"
  printf '%s\n' "${results[@]+"${results[@]}"}"
}

measure_brew_usage() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "0B (Homebrew not installed)"
    return 0
  fi
  local cellar
  cellar="$(brew --cellar 2>/dev/null || true)"
  local paths=()
  local installed=()
  local pkg
  for pkg in llama.cpp whisper-cpp; do
    if [[ -n "$cellar" && -d "$cellar/$pkg" ]]; then
      paths+=("$cellar/$pkg")
      installed+=("$pkg")
    elif brew list --formula "$pkg" >/dev/null 2>&1; then
      installed+=("$pkg")
    fi
  done
  if [[ ${#installed[@]} -eq 0 ]]; then
    echo "0B (not installed)"
    return 0
  fi
  local size_str="installed"
  if [[ ${#paths[@]} -gt 0 ]]; then
    size_str="$(measure_paths_usage "${paths[@]}")"
  fi
  echo "$size_str (${installed[*]})"
}

print_disk_usage_summary() {
  local runtime_usage deps_usage models_usage data_usage brew_usage

  runtime_usage="$(measure_paths_usage "$PROJECT_ROOT/.pids" "$PROJECT_ROOT/logs")"
  deps_usage="$(measure_paths_usage \
    "$PROJECT_ROOT/adk_backend/.venv" \
    "$PROJECT_ROOT/node_modules" \
    "$PROJECT_ROOT/dist" \
    "$PROJECT_ROOT/.pytest_cache")"

  local model_paths=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && model_paths+=("$line")
  done < <(collect_model_paths)
  models_usage="$(measure_paths_usage "${model_paths[@]+"${model_paths[@]}"}")"

  local data_paths=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && data_paths+=("$line")
  done < <(collect_data_paths)
  if [[ ${#data_paths[@]} -eq 0 && -d "$PROJECT_ROOT/data" ]]; then
    data_usage="$(measure_paths_usage "$PROJECT_ROOT/data")"
  else
    data_usage="$(measure_paths_usage "${data_paths[@]+"${data_paths[@]}"}")"
  fi

  brew_usage="$(measure_brew_usage)"

  echo ""
  echo "================================================================================"
  echo "  EchoLearning — Disk Usage & Uninstall Summary"
  echo "  Target: $PROJECT_ROOT"
  echo "================================================================================"
  printf "  %-42s %s\n" "Running services & PIDs (.pids/, logs/):" "$runtime_usage"
  printf "  %-42s %s\n" "Local AI Models (models/*.gguf, *.bin):" "$models_usage"
  printf "  %-42s %s\n" "Python/Node Deps & Build (.venv, dist):" "$deps_usage"
  printf "  %-42s %s\n" "Study Data & Recordings (data/):" "$data_usage"
  printf "  %-42s %s\n" "Homebrew AI Engines (llama/whisper):" "$brew_usage"
  echo "================================================================================"
}

# ---------------------------------------------------------------------------
# Determine Removal Selections
# ---------------------------------------------------------------------------

REMOVE_DEPS=false
REMOVE_MODELS=false
REMOVE_DATA=false

if [[ -n "$MODE" ]]; then
  if [[ "$MODE" == "deps-only" ]]; then
    REMOVE_DEPS=true
    REMOVE_MODELS=false
    REMOVE_DATA=false
  elif [[ "$MODE" == "all" ]]; then
    REMOVE_DEPS=true
    [[ "$KEEP_MODELS" == false ]] && REMOVE_MODELS=true
    [[ "$KEEP_DATA" == false ]] && REMOVE_DATA=true
  fi
else
  if [[ "$NON_INTERACTIVE" == true || "$AUTO_YES" == true ]]; then
    echo "Error: Non-interactive mode requires either --all or --deps-only." >&2
    exit 1
  fi

  print_disk_usage_summary
  echo ""
  echo "Select an uninstall option:"
  echo "  [1] Clean Dependencies & AI Models (Keep Study Data in data/)"
  echo "  [2] Full Application Reset (Remove Dependencies, AI Models & Study Data)"
  echo "  [3] Complete Uninstall (Remove Everything + Homebrew llama.cpp/whisper-cpp + Optional App Folder)"
  echo "  [4] Custom Selection (Choose each component interactively)"
  echo "  [5] Cancel"
  echo ""
  read -r -p "Enter choice [1-5]: " menu_choice

  case "$menu_choice" in
    1)
      REMOVE_DEPS=true
      [[ "$KEEP_MODELS" == false ]] && REMOVE_MODELS=true
      REMOVE_DATA=false
      ;;
    2)
      REMOVE_DEPS=true
      [[ "$KEEP_MODELS" == false ]] && REMOVE_MODELS=true
      [[ "$KEEP_DATA" == false ]] && REMOVE_DATA=true
      ;;
    3)
      REMOVE_DEPS=true
      [[ "$KEEP_MODELS" == false ]] && REMOVE_MODELS=true
      [[ "$KEEP_DATA" == false ]] && REMOVE_DATA=true
      REMOVE_BREW=true
      if [[ "$REMOVE_APP_DIR" == false ]]; then
        read -r -p "Also delete the entire EchoLearning folder ($PROJECT_ROOT)? [y/N]: " ans_app
        if [[ "$ans_app" =~ ^[Yy]$ ]]; then
          REMOVE_APP_DIR=true
        fi
      fi
      ;;
    4)
      read -r -p "Remove Python .venv, node_modules, dist, logs, .pids, .pytest_cache? [y/N]: " ans_deps
      [[ "$ans_deps" =~ ^[Yy]$ ]] && REMOVE_DEPS=true

      if [[ "$KEEP_MODELS" == false ]]; then
        read -r -p "Remove Local AI Models (models/*.gguf, *.bin, manifest.json)? [y/N]: " ans_models
        [[ "$ans_models" =~ ^[Yy]$ ]] && REMOVE_MODELS=true
      fi

      if [[ "$KEEP_DATA" == false ]]; then
        read -r -p "Remove Local Study Data (data/echolearning.sqlite3 & data/audio/)? [y/N]: " ans_data
        [[ "$ans_data" =~ ^[Yy]$ ]] && REMOVE_DATA=true
      fi

      read -r -p "Uninstall Homebrew llama.cpp and whisper-cpp? [y/N]: " ans_brew
      [[ "$ans_brew" =~ ^[Yy]$ ]] && REMOVE_BREW=true

      read -r -p "Delete the EchoLearning project folder itself ($PROJECT_ROOT)? [y/N]: " ans_app_dir
      [[ "$ans_app_dir" =~ ^[Yy]$ ]] && REMOVE_APP_DIR=true
      ;;
    5|"")
      echo "Uninstall cancelled."
      exit 0
      ;;
    *)
      echo "Invalid selection '$menu_choice'. Uninstall cancelled." >&2
      exit 1
      ;;
  esac

  if [[ "$REMOVE_DATA" == true && -z "$BACKUP_DIR" && -d "$PROJECT_ROOT/data" && -n "$(ls -A "$PROJECT_ROOT/data" 2>/dev/null || true)" ]]; then
    read -r -p "Optional: Enter a backup directory for data/ before deletion (leave blank to skip): " prompt_backup
    if [[ -n "$prompt_backup" ]]; then
      BACKUP_DIR="${prompt_backup/#\~/$HOME}"
    fi
  fi
fi

if [[ -n "$MODE" ]]; then
  print_disk_usage_summary
fi

# ---------------------------------------------------------------------------
# Action Plan Preview & Confirmation
# ---------------------------------------------------------------------------

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "[DRY-RUN] Previewing uninstall actions (no files or services will be modified):"
else
  echo "Planned actions:"
fi
echo "  • Stop running EchoLearning services (.pids/ & scripts/stop.sh)"
echo "  • Remove dependencies & caches (.venv, node_modules, dist, logs, .pids, .pytest_cache): $REMOVE_DEPS"
echo "  • Remove local AI models (models/*.gguf, *.bin, manifest.json): $REMOVE_MODELS"
echo "  • Remove study data (data/): $REMOVE_DATA"
if [[ -n "$BACKUP_DIR" && "$REMOVE_DATA" == true ]]; then
  echo "  • Back up data/ before removal into: $BACKUP_DIR"
fi
echo "  • Uninstall Homebrew llama.cpp & whisper-cpp: $REMOVE_BREW"
echo "  • Remove EchoLearning directory ($PROJECT_ROOT): $REMOVE_APP_DIR"

if [[ "$DRY_RUN" == false && "$AUTO_YES" == false && "$NON_INTERACTIVE" == false ]]; then
  echo ""
  read -r -p "Proceed with these actions? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Uninstall cancelled."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 1: Stop Running Services Safely
# ---------------------------------------------------------------------------

stop_running_services() {
  local owner_file="$PROJECT_ROOT/.pids/launcher.lock/owner"

  if [[ "$DRY_RUN" == true ]]; then
    if [[ -x "$PROJECT_ROOT/scripts/stop.sh" && -f "$owner_file" ]]; then
      echo "[DRY-RUN] Would run: $PROJECT_ROOT/scripts/stop.sh"
    fi
    local prev_nullglob
    prev_nullglob="$(shopt -p nullglob || true)"
    shopt -s nullglob
    local pf
    for pf in "$PROJECT_ROOT/.pids/"*.pid; do
      echo "[DRY-RUN] Would inspect PID file and stop EchoLearning service if running: $pf"
    done
    eval "$prev_nullglob"
    return 0
  fi

  if [[ -x "$PROJECT_ROOT/scripts/stop.sh" && -f "$owner_file" ]]; then
    local launcher_pid=""
    launcher_pid="$(head -n 1 "$owner_file" 2>/dev/null | tr -d '[:space:]' || true)"
    echo "Stopping managed EchoLearning launcher via scripts/stop.sh..."
    "$PROJECT_ROOT/scripts/stop.sh" || true
    if [[ "$launcher_pid" =~ ^[1-9][0-9]*$ ]]; then
      local waits=0
      while kill -0 "$launcher_pid" 2>/dev/null && [[ $waits -lt 25 ]]; do
        sleep 0.2
        waits=$((waits + 1))
      done
    fi
  fi

  local prev_nullglob
  prev_nullglob="$(shopt -p nullglob || true)"
  shopt -s nullglob
  local pf
  for pf in "$PROJECT_ROOT/.pids/"*.pid; do
    local pid=""
    pid="$(head -n 1 "$pf" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" 2>/dev/null; then
      local cmd=""
      cmd="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
      if [[ "$cmd" == *llama-server* || "$cmd" == *start_llama.sh* || "$cmd" == *whisper-server* || "$cmd" == *start_whisper.sh* || "$cmd" == *adk_backend* || "$cmd" == *uvicorn* || "$cmd" == *vite* || "$cmd" == *EchoLearning* ]]; then
        echo "Stopping EchoLearning process (PID $pid from $(basename "$pf"))..."
        kill -TERM "$pid" 2>/dev/null || true
        local i=0
        while kill -0 "$pid" 2>/dev/null && [[ $i -lt 15 ]]; do
          sleep 0.2
          i=$((i + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
    fi
    rm -f "$pf"
  done
  eval "$prev_nullglob"

  rm -rf "$PROJECT_ROOT/.pids/launcher.lock"
}

stop_running_services

# ---------------------------------------------------------------------------
# Step 2: Optional Timestamped Study Data Backup
# ---------------------------------------------------------------------------

if [[ "$REMOVE_DATA" == true && -n "$BACKUP_DIR" ]]; then
  if [[ -d "$PROJECT_ROOT/data" && -n "$(ls -A "$PROJECT_ROOT/data" 2>/dev/null || true)" ]]; then
    timestamp="$(date +%Y%m%d-%H%M%S)"
    archive_path="$BACKUP_DIR/echolearning-study-backup-${timestamp}.tar.gz"
    if [[ "$DRY_RUN" == true ]]; then
      echo "[DRY-RUN] Would create backup directory: $BACKUP_DIR"
      echo "[DRY-RUN] Would archive $PROJECT_ROOT/data to $archive_path"
    else
      mkdir -p "$BACKUP_DIR"
      echo "Creating study data backup at $archive_path..."
      tar -czf "$archive_path" -C "$PROJECT_ROOT" data
      echo "✓ Backup saved: $archive_path"
    fi
  else
    if [[ "$DRY_RUN" == true ]]; then
      echo "[DRY-RUN] Skipping backup (data/ is absent or empty)."
    else
      echo "Skipping backup (data/ is absent or empty)."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Remove Selected Project Components
# ---------------------------------------------------------------------------

remove_target() {
  local target="$1"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 0
  fi
  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY-RUN] Would remove: $target"
  else
    echo "Removing: $target"
    rm -rf "$target"
  fi
}

if [[ "$REMOVE_DEPS" == true ]]; then
  remove_target "$PROJECT_ROOT/.pids"
  remove_target "$PROJECT_ROOT/logs"
  remove_target "$PROJECT_ROOT/adk_backend/.venv"
  remove_target "$PROJECT_ROOT/node_modules"
  remove_target "$PROJECT_ROOT/dist"
  remove_target "$PROJECT_ROOT/.pytest_cache"
fi

if [[ "$REMOVE_MODELS" == true ]]; then
  model_targets=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && model_targets+=("$line")
  done < <(collect_model_paths)
  for mt in "${model_targets[@]+"${model_targets[@]}"}"; do
    remove_target "$mt"
  done
  if [[ -d "$PROJECT_ROOT/models" ]]; then
    if [[ "$DRY_RUN" == true ]]; then
      echo "[DRY-RUN] Would remove empty models/ directory if empty: $PROJECT_ROOT/models"
    else
      rmdir "$PROJECT_ROOT/models" 2>/dev/null || true
    fi
  fi
fi

if [[ "$REMOVE_DATA" == true ]]; then
  remove_target "$PROJECT_ROOT/data"
fi

# ---------------------------------------------------------------------------
# Step 4: Optional Homebrew Local AI Engine Removal
# ---------------------------------------------------------------------------

if [[ "$REMOVE_BREW" == true ]]; then
  if command -v brew >/dev/null 2>&1; then
    for pkg in llama.cpp whisper-cpp; do
      if brew list --formula "$pkg" >/dev/null 2>&1; then
        if [[ "$DRY_RUN" == true ]]; then
          echo "[DRY-RUN] Would run: brew uninstall $pkg"
        else
          echo "Uninstalling Homebrew package: $pkg..."
          brew uninstall "$pkg" || true
        fi
      else
        echo "Homebrew formula '$pkg' is not installed (skipping)."
      fi
    done
  else
    echo "Homebrew not found; skipping brew package uninstall."
  fi
  echo "Note: Shared system tools (ffmpeg, node, python) were NOT uninstalled because other tools may rely on them."
fi

# ---------------------------------------------------------------------------
# Step 5: Optional Project Directory Removal
# ---------------------------------------------------------------------------

if [[ "$REMOVE_APP_DIR" == true ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY-RUN] Would remove EchoLearning directory: $PROJECT_ROOT"
  else
    parent_dir="$(dirname "$PROJECT_ROOT")"
    cd "$parent_dir"
    echo "Removing EchoLearning directory: $PROJECT_ROOT"
    rm -rf "$PROJECT_ROOT"
  fi
fi

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "✓ Dry-run complete. No files were modified."
else
  echo "✓ EchoLearning uninstall/cleanup complete."
fi
