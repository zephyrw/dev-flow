#!/bin/sh
# Verified release bootstrap. Source mode requires a complete built bundle.
set -eu
source_dir=""
install_dir="$HOME/.local/share/devflow"
selected_tools="codex"
version="latest"
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { echo "Missing argument: $1" >&2; exit 30; }
  case "$1" in
    --source|-s) source_dir="$2";;
    --install-dir|-i) install_dir="$2";;
    --tool|--tools|-t) selected_tools="$2";;
    --version) version="$2";;
    *) echo "Unknown argument: $1" >&2; exit 30;;
  esac
  shift 2
done
os="$(uname -s)"
case "$os" in Darwin) platform=darwin;; Linux) platform=linux;; *) echo "Unsupported OS" >&2; exit 40;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) exit 40;; esac
if [ -z "$source_dir" ]; then
  command -v curl >/dev/null && command -v tar >/dev/null || exit 40
  temp="$(mktemp -d)"
  trap 'rm -rf "$temp"' EXIT HUP INT TERM
  if [ "$version" = latest ]; then
    version="$(curl --fail --location --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' https://github.com/zephyrw/dev-flow/releases/latest)" || exit 20
    version="${version##*/}"
  fi
  case "$version" in
    v[0-9]*) base="https://github.com/zephyrw/dev-flow/releases/download/$version";;
    *) echo "Invalid version" >&2; exit 30;; esac
  asset="devflow-$version-$platform-$arch.tar.gz"
  curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset" -o "$temp/$asset" || exit 20
  curl --fail --location --proto '=https' --tlsv1.2 "$base/$asset.sha256" -o "$temp/$asset.sha256" || exit 20
  expected="$(awk 'NR==1 {print $1}' "$temp/$asset.sha256")"
  if command -v sha256sum >/dev/null; then actual="$(sha256sum "$temp/$asset" | awk '{print $1}')"
  else actual="$(shasum -a 256 "$temp/$asset" | awk '{print $1}')"; fi
  [ "$expected" = "$actual" ] || { echo "Checksum mismatch" >&2; exit 20; }
  tar -tzf "$temp/$asset" > "$temp/entries" || exit 20
  if grep -E '(^/|(^|/)\.\.(/|$)|\\|:)' "$temp/entries" >/dev/null; then echo "Unsafe archive path" >&2; exit 20; fi
  mkdir "$temp/bundle"
  tar -xzf "$temp/$asset" -C "$temp/bundle" || exit 20
  source_dir="$temp/bundle/devflow"
fi
source_dir="$(cd "$source_dir" && pwd)"
node="$source_dir/runtime/node"
if [ ! -x "$node" ]; then node="$(command -v node)" || exit 40; fi
[ -f "$source_dir/dist/packages/installer/src/main.js" ] || { echo "Incomplete built bundle" >&2; exit 20; }
"$node" "$source_dir/dist/packages/installer/src/main.js" --source "$source_dir" --install-dir "$install_dir" --tools "$selected_tools"
