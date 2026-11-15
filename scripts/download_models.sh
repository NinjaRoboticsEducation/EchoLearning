#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
models_dir="$root/models"
mkdir -p "$models_dir"
cd "$models_dir"

NON_INTERACTIVE="${ECHO_NONINTERACTIVE:-0}"
REQUESTED_MODELS="${ECHO_MODELS:-}"
WRITE_MANIFEST_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive|--default)
      NON_INTERACTIVE=1
      shift
      ;;
    --models)
      REQUESTED_MODELS="${2:-}"
      shift 2
      ;;
    --write-manifest-only)
      WRITE_MANIFEST_ONLY=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./scripts/download_models.sh [OPTIONS]

Options:
  --non-interactive, --default  Use default/recommended model without prompting
  --models <list>               Comma-separated model IDs or menu numbers (e.g. "1,3" or "qwen3.5-4b-q6_k")
  --write-manifest-only         Scan installed models and update models/manifest.json without downloading
  -h, --help                    Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

ARCH="$(uname -m)"
CPU_BRAND="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "macOS CPU")"
RAM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 17179869184)"
RAM_GB=$(( RAM_BYTES / 1073741824 ))
FREE_DISK_GB="$(df -Pk "$root" | awk 'NR==2 {printf "%d", int($4 / 1048576)}')"

WHISPER_FILE="ggml-large-v3-turbo.bin"
WHISPER_SHA="1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/6034871ec87c84e342efab769d4c5c06cd126db3/ggml-large-v3-turbo.bin"

MODEL_IDS=(
  "qwen3.5-4b-q6_k"
  "qwen3.5-9b-q4_k_m"
  "qwen3.5-9b-q6_k"
  "qwen3.5-27b-q4_k_m"
  "qwen3.5-35b-a3b-q4_k_m"
)
MODEL_FILES=(
  "Qwen3.5-4B-Q6_K.gguf"
  "Qwen3.5-9B-Q4_K_M.gguf"
  "Qwen3.5-9B-Q6_K.gguf"
  "Qwen3.5-27B-Q4_K_M.gguf"
  "Qwen3.5-35B-A3B-Q4_K_M.gguf"
)
MODEL_SHAS=(
  "fdedd781c9ce676ab66b018ca247ff78e8a33c98098a822c1e2d5075e7718f66"
  "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8"
  "91898433cf5ce0a8f45516a4cc3e9343b6e01d052d01f684309098c66a326c59"
  "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806"
  "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375"
)
MODEL_URLS=(
  "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176/Qwen3.5-4B-Q6_K.gguf"
  "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219/Qwen3.5-9B-Q4_K_M.gguf"
  "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/46c7e1d/Qwen3.5-9B-Q6_K.gguf"
  "https://huggingface.co/unsloth/Qwen3.5-27B-GGUF/resolve/3221f17/Qwen3.5-27B-Q4_K_M.gguf"
  "https://huggingface.co/unsloth/Qwen3.5-35B-A3B-GGUF/resolve/bc014a1/Qwen3.5-35B-A3B-Q4_K_M.gguf"
)
MODEL_DESCS=(
  "Qwen3.5-4B-GGUF:Q6_K       (3.28 GiB | ~4.2 GB RAM)  — Fast CPU response; great for 16 GB Intel Macs"
  "Qwen3.5-9B-GGUF:Q4_K_M     (5.29 GiB | ~6.2 GB RAM)  — Balanced 9B quality & lower RAM for 16 GB Macs"
  "Qwen3.5-9B-GGUF:Q6_K       (6.95 GiB | ~7.8 GB RAM)  — Default high-precision bilingual model [Recommended]"
  "Qwen3.5-27B-GGUF:Q4_K_M    (15.59 GiB | ~17.2 GB RAM)— Pro dense model (Requires 32 GB+ RAM)"
  "Qwen3.5-35B-A3B-GGUF:Q4_K_M(20.50 GiB | ~22.0 GB RAM)— Fast 35B MoE model (Requires 32 GB+ RAM)"
)
MODEL_MIN_RAM=(8 16 16 32 32)
MODEL_SIZES_GB=(4 6 7 16 21)

verify() {
  printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c - >/dev/null
}

fetch_model() {
  local name="$1" digest="$2" url="$3"
  if [[ -e "$name" ]]; then
    if verify "$digest" "$name"; then
      echo "✓ Verified $name"
      return 0
    else
      echo "Checksum mismatch for $PWD/$name. Move the file aside and retry." >&2
      return 1
    fi
  fi
  local staged="./.${name}.part"
  echo "Downloading $name..."
  if curl -C - --fail --location --retry 5 --connect-timeout 30 --output "$staged" "$url" &&
     verify "$digest" "$staged"; then
    mv -f "$staged" "$name"
    echo "✓ Downloaded and verified $name"
  else
    echo "❌ Failed download or checksum verification for $name (partial file kept at $staged for resume)." >&2
    return 1
  fi
}

write_manifest() {
  local preferred_active="$1"
  python3 - "$models_dir" "$preferred_active" <<'PY'
import json, os, sys
from datetime import datetime, timezone
from pathlib import Path

models_dir = Path(sys.argv[1])
preferred_active = sys.argv[2]
manifest_path = models_dir / "manifest.json"

catalog = {
    "Qwen3.5-4B-Q6_K.gguf": "qwen3.5-4b-q6_k",
    "Qwen3.5-9B-Q4_K_M.gguf": "qwen3.5-9b-q4_k_m",
    "Qwen3.5-9B-Q6_K.gguf": "qwen3.5-9b-q6_k",
    "Qwen3.5-27B-Q4_K_M.gguf": "qwen3.5-27b-q4_k_m",
    "Qwen3.5-35B-A3B-Q4_K_M.gguf": "qwen3.5-35b-a3b-q4_k_m",
}

installed_ids = []
for fname, pid in catalog.items():
    p = models_dir / fname
    if p.is_file() and p.stat().st_size > 0:
        installed_ids.append(pid)

existing_active = ""
if manifest_path.is_file():
    try:
        existing_active = json.loads(manifest_path.read_text(encoding="utf-8")).get("active_model", "")
    except Exception:
        pass

active = preferred_active if preferred_active in installed_ids else (
    existing_active if existing_active in installed_ids else (
        installed_ids[0] if installed_ids else preferred_active
    )
)

payload = {
    "active_model": active,
    "activeProfileId": active,
    "installed_models": installed_ids,
    "whisper_model": "ggml-large-v3-turbo.bin" if (models_dir / "ggml-large-v3-turbo.bin").is_file() else "",
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
tmp = manifest_path.with_suffix(".json.tmp")
tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
os.replace(tmp, manifest_path)
print(f"✓ Updated {manifest_path} (active_model={active}, installed={installed_ids})")
PY
}

if [[ "$WRITE_MANIFEST_ONLY" -eq 1 ]]; then
  write_manifest "qwen3.5-9b-q6_k"
  exit 0
fi

echo "--------------------------------------------------------------------------------"
echo "Detected Hardware: $CPU_BRAND ($ARCH) · ${RAM_GB} GB RAM · ${FREE_DISK_GB} GB free disk"
whisper_badge="Pending"
if [[ -f "$WHISPER_FILE" ]]; then
  whisper_badge="Installed"
fi
echo "Mandatory STT Engine: Whisper Large-v3-Turbo (1.51 GiB) [$whisper_badge]"
echo ""

selected_indices=()

resolve_selection_token() {
  local tok
  tok="$(echo "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$tok" in
    1|qwen3.5-4b-q6_k) echo 0 ;;
    2|qwen3.5-9b-q4_k_m) echo 1 ;;
    3|qwen3.5-9b-q6_k|default) echo 2 ;;
    4|qwen3.5-27b-q4_k_m) echo 3 ;;
    5|qwen3.5-35b-a3b-q4_k_m) echo 4 ;;
    *) return 1 ;;
  esac
}

has_tty=0
if ( : < /dev/tty ) 2>/dev/null; then
  has_tty=1
fi

if [[ -n "$REQUESTED_MODELS" ]]; then
  IFS=',' read -ra raw_tokens <<< "$REQUESTED_MODELS"
  for tok in ${raw_tokens[@]+"${raw_tokens[@]}"}; do
    idx="$(resolve_selection_token "$tok" || true)"
    if [[ -n "$idx" ]]; then
      selected_indices+=("$idx")
    else
      echo "Unknown model selection: '$tok'" >&2
      exit 1
    fi
  done
elif [[ "$NON_INTERACTIVE" -eq 1 || ( ! -t 0 && "$has_tty" -eq 0 ) ]]; then
  # Default tier: Qwen3.5-9B-Q6_K (index 2)
  selected_indices=(2)
else
  echo "Select one or more local LLM models to install (comma-separated, e.g. \"1,3\" or Enter for default [3]):"
  for i in "${!MODEL_IDS[@]}"; do
    badge=""
    if [[ -f "${MODEL_FILES[$i]}" ]]; then
      badge=" [INSTALLED]"
    fi
    marker=" "
    if [[ "$i" -eq 2 ]]; then
      marker="*"
    fi
    printf " %s [%d] %s%s\n" "$marker" "$((i + 1))" "${MODEL_DESCS[$i]}" "$badge"
  done
  printf "\nSelection [3]: "
  if [[ "$has_tty" -eq 1 ]]; then
    read -r user_input < /dev/tty || user_input=""
  elif [[ -t 0 ]]; then
    read -r user_input || user_input=""
  else
    user_input="3"
  fi
  user_input="${user_input:-3}"
  IFS=',' read -ra raw_tokens <<< "$user_input"
  for tok in ${raw_tokens[@]+"${raw_tokens[@]}"}; do
    idx="$(resolve_selection_token "$tok" || true)"
    if [[ -n "$idx" ]]; then
      selected_indices+=("$idx")
    else
      echo "Invalid selection: '$tok'" >&2
      exit 1
    fi
  done
fi

if [[ ${#selected_indices[@]} -eq 0 ]]; then
  selected_indices=(2)
fi

# Warn on Tier 3/4 models on < 24 GB RAM when interactive
needed_gb=0
if [[ ! -f "$WHISPER_FILE" ]]; then
  needed_gb=$((needed_gb + 2))
fi
for idx in ${selected_indices[@]+"${selected_indices[@]}"}; do
  if [[ ! -f "${MODEL_FILES[$idx]}" ]]; then
    needed_gb=$((needed_gb + MODEL_SIZES_GB[idx]))
  fi
  if [[ "$NON_INTERACTIVE" -eq 0 && "$RAM_GB" -lt 24 && "${MODEL_MIN_RAM[$idx]}" -ge 32 ]]; then
    echo "⚠️  Warning: ${MODEL_FILES[$idx]} recommends ${MODEL_MIN_RAM[$idx]} GB+ RAM, but this machine has ${RAM_GB} GB."
    printf "Continue anyway? [y/N]: "
    if [[ "$has_tty" -eq 1 ]]; then
      read -r confirm < /dev/tty || confirm="n"
    elif [[ -t 0 ]]; then
      read -r confirm || confirm="n"
    else
      confirm="n"
    fi
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      echo "Aborted by user."
      exit 1
    fi
  fi
done

if [[ "$FREE_DISK_GB" -gt 0 && "$needed_gb" -gt "$FREE_DISK_GB" ]]; then
  echo "❌ Insufficient disk space: need ~${needed_gb} GB free, found ${FREE_DISK_GB} GB." >&2
  exit 1
fi

# Always install mandatory Whisper ASR model
fetch_model "$WHISPER_FILE" "$WHISPER_SHA" "$WHISPER_URL"

# Download & verify selected GGUF tiers
first_selected_id=""
for idx in ${selected_indices[@]+"${selected_indices[@]}"}; do
  if [[ -z "$first_selected_id" ]]; then
    first_selected_id="${MODEL_IDS[$idx]}"
  fi
  fetch_model "${MODEL_FILES[$idx]}" "${MODEL_SHAS[$idx]}" "${MODEL_URLS[$idx]}"
done

# Prefer qwen3.5-9b-q6_k as active default if installed, else first selected
active_pref="qwen3.5-9b-q6_k"
if [[ ! -f "Qwen3.5-9B-Q6_K.gguf" && -n "$first_selected_id" ]]; then
  active_pref="$first_selected_id"
fi
write_manifest "$active_pref"
