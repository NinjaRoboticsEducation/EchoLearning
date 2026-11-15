#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/models"
cd "$root/models"

verify() {
  printf '%s  %s\n' "$1" "$2" | shasum -a 256 -c - >/dev/null
}

fetch_model() {
  local name="$1" digest="$2" url="$3"
  if [[ -e "$name" ]]; then
    if ! verify "$digest" "$name"; then
      echo "Checksum mismatch for $PWD/$name. Move the file aside and retry." >&2
      return 1
    fi
    return
  fi
  local staged
  staged="$(mktemp "./${name}.XXXXXX")"
  if curl --fail --location --retry 3 --connect-timeout 30 --output "$staged" "$url" &&
     verify "$digest" "$staged"; then
    mv -f "$staged" "$name"
  else
    rm -f "$staged"
    return 1
  fi
}

fetch_model ggml-large-v3-turbo.bin 1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69 \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/6034871ec87c84e342efab769d4c5c06cd126db3/ggml-large-v3-turbo.bin
fetch_model Qwen3.5-9B-Q6_K.gguf 91898433cf5ce0a8f45516a4cc3e9343b6e01d052d01f684309098c66a326c59 \
  https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/46c7e1d/Qwen3.5-9B-Q6_K.gguf
