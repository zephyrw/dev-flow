#!/bin/sh
# DevFlow release bootstrap (macOS / Linux).
#
# Release builds must replace __DEVFLOW_RELEASE_TAG__ with the immutable tag
# (e.g. v0.2.0) so the script pins manifest + artifacts to that tag and never
# re-resolves latest. A leftover placeholder marks a development copy.
#
# Exit codes follow packages/installer/src/state.ts INSTALL_EXIT_CODES:
#   0  success (software runnable; model setup may still be onboarding)
#  10  NEEDS_USER_ACTION (only when --require-ready; kept for installer callers)
#  20  DOWNLOAD_VERIFICATION_FAILED (also incomplete bundle)
#  30  CONFIGURATION_CONFLICT (bad arguments)
#  40  UNSUPPORTED_ENVIRONMENT
#  50  SERVICE_UNHEALTHY
set -eu

DEVFLOW_RELEASE_TAG="__DEVFLOW_RELEASE_TAG__"
# First-release public matrix (plan §5.5). Unknown / 32-bit / linux-arm64 rejected.
DEVFLOW_SUPPORTED_TARGETS="darwin-x64 darwin-arm64 linux-x64"
MANIFEST_MAX_BYTES=65536

source_dir=""
source_mode=0
install_dir="${HOME}/.local/share/devflow"
selected_tools=""
tools_explicit=0
version=""
no_open=0
require_ready=0
planner_tool=""
planner_model=""
planner_effort=""
executor_tool=""
executor_model=""
executor_effort=""
temp=""
setup_url=""
setup_pending=0

usage_error() {
  printf '%s\n' "$1" >&2
  printf '%s\n' "用法: install.sh [--version vX.Y.Z] [--install-dir DIR] [--no-open] [--require-ready] [--source DIR] [--tool TOOLS]" >&2
  exit 30
}

cleanup() {
  if [ -n "$temp" ] && [ -d "$temp" ]; then
    rm -rf "$temp"
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-open)
        no_open=1
        shift
        ;;
      --require-ready)
        require_ready=1
        shift
        ;;
      --source|-s)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        source_dir=$2
        source_mode=1
        shift 2
        ;;
      --install-dir|-i)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        install_dir=$2
        shift 2
        ;;
      --tool|--tools|-t)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        selected_tools=$2
        tools_explicit=1
        shift 2
        ;;
      --version)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        version=$2
        shift 2
        ;;
      --planner-tool)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        planner_tool=$2
        shift 2
        ;;
      --planner-model)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        planner_model=$2
        shift 2
        ;;
      --planner-effort)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        planner_effort=$2
        shift 2
        ;;
      --executor-tool)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        executor_tool=$2
        shift 2
        ;;
      --executor-model)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        executor_model=$2
        shift 2
        ;;
      --executor-effort)
        [ "$#" -ge 2 ] || usage_error "缺少参数值: $1"
        executor_effort=$2
        shift 2
        ;;
      *)
        usage_error "未知参数: $1"
        ;;
    esac
  done
  if [ -z "$install_dir" ]; then
    usage_error "--install-dir 不能为空"
  fi
}

# --- platform / arch (I-08): never map unknown or 32-bit to x64 ---
detect_os() {
  _os=$(uname -s 2>/dev/null) || _os=""
  case "$_os" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *)
      printf '%s\n' "不支持的操作系统：${_os:-unknown}" >&2
      exit 40
      ;;
  esac
}

detect_arch() {
  _m=$(uname -m 2>/dev/null) || _m=""
  case "$_m" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    i386|i486|i586|i686|x86)
      printf '%s\n' "不支持 32 位架构：$_m（不会映射为 x64）" >&2
      exit 40
      ;;
    *)
      printf '%s\n' "不支持的架构：${_m:-unknown}（不会映射为 x64）" >&2
      exit 40
      ;;
  esac
}

assert_supported_target() {
  target="$platform-$arch"
  case " $DEVFLOW_SUPPORTED_TARGETS " in
    *" $target "*) ;;
    *)
      printf '%s\n' "当前平台尚无官方安装包：$target" >&2
      printf '%s\n' "支持的目标：$DEVFLOW_SUPPORTED_TARGETS" >&2
      exit 40
      ;;
  esac
}

is_placeholder_tag() {
  [ "$1" = "__DEVFLOW_RELEASE_TAG__" ] || [ -z "$1" ]
}

is_prerelease_tag() {
  # v1.2.3-rc.1 / v1.2.3-beta+build → prerelease; v1.2.3 → stable
  case "$1" in
    v[0-9]*-*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_version_tag() {
  case "$1" in
    v[0-9]*)
      # reject path separators and whitespace smuggled into the tag
      case "$1" in
        *[!A-Za-z0-9._+-]*|*/*|*\\*)
          printf '%s\n' "无效的版本标签：$1" >&2
          exit 30
          ;;
      esac
      ;;
    *)
      printf '%s\n' "无效的版本标签：$1（应形如 v1.2.3）" >&2
      exit 30
      ;;
  esac
}

# Version resolution happens exactly once (plan §4.3).
resolve_version_once() {
  if [ -n "$version" ]; then
    validate_version_tag "$version"
    # explicit --version may select a prerelease
    return 0
  fi
  if ! is_placeholder_tag "$DEVFLOW_RELEASE_TAG"; then
    validate_version_tag "$DEVFLOW_RELEASE_TAG"
    version=$DEVFLOW_RELEASE_TAG
    return 0
  fi
  # Development bootstrap only: resolve latest once (GitHub latest is stable).
  # Formal assets must ship with the placeholder already replaced.
  printf '%s\n' "开发版 bootstrap：未嵌入发布标签，解析 latest 一次。" >&2
  command -v curl >/dev/null 2>&1 || {
    printf '%s\n' "缺少 curl，无法解析版本" >&2
    exit 40
  }
  _effective=$(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    -o /dev/null -w '%{url_effective}' \
    "https://github.com/zephyrw/dev-flow/releases/latest") || {
      printf '%s\n' "无法解析 latest 版本" >&2
      exit 20
    }
  version=${_effective##*/}
  validate_version_tag "$version"
  # stable channel never silently installs a prerelease
  if is_prerelease_tag "$version"; then
    printf '%s\n' "latest 解析到预发布标签：$version；预发布必须显式 --version" >&2
    exit 30
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf '%s\n' "缺少 sha256sum/shasum" >&2
    exit 40
  fi
}

# Strict manifest checks (plan §5.6): size, shape, tag, platform, digest.
# Prints the expected asset sha256 on success (stdout).
validate_manifest_file() {
  _mf=$1
  _expect_target=$2
  _expect_tag=$3
  [ -f "$_mf" ] || {
    printf '%s\n' "manifest 不存在" >&2
    return 1
  }
  _size=$(wc -c < "$_mf" | tr -d '[:space:]')
  if [ -z "$_size" ] || [ "$_size" -le 0 ] || [ "$_size" -gt "$MANIFEST_MAX_BYTES" ]; then
    printf '%s\n' "manifest 大小不合法：${_size:-0}（上限 $MANIFEST_MAX_BYTES）" >&2
    return 1
  fi
  # single JSON object (portable head/tail char — no `rev`)
  _compact=$(tr -d '\n\r\t ' < "$_mf")
  _head=$(printf '%.1s' "$_compact")
  _tail=$(printf '%s' "$_compact" | awk '{print substr($0,length($0),1)}')
  if [ "$_head" != "{" ] || [ "$_tail" != "}" ]; then
    printf '%s\n' "manifest 不是单个 JSON 对象" >&2
    return 1
  fi
  if grep -q '__DEVFLOW_[A-Z_]*__' "$_mf"; then
    printf '%s\n' "manifest 含未替换占位符" >&2
    return 1
  fi
  if ! grep -Eq '"tag"[[:space:]]*:[[:space:]]*"'"$_expect_tag"'"' "$_mf"; then
    printf '%s\n' "manifest 标签与请求版本不一致（期望 $_expect_tag）" >&2
    return 1
  fi
  if ! grep -Eq '"'"$_expect_target"'"' "$_mf"; then
    printf '%s\n' "manifest 不含目标平台组件：$_expect_target" >&2
    return 1
  fi
  _plat=${_expect_target%-*}
  _arch_part=${_expect_target#*-}
  if ! grep -Eq '"platform"[[:space:]]*:[[:space:]]*"'"$_plat"'"' "$_mf"; then
    printf '%s\n' "manifest 平台字段与 $_expect_target 不符" >&2
    return 1
  fi
  if ! grep -Eq '"arch"[[:space:]]*:[[:space:]]*"'"$_arch_part"'"' "$_mf"; then
    printf '%s\n' "manifest 架构字段与 $_expect_target 不符" >&2
    return 1
  fi
  # exactly one sha256 digest for the component block
  _digests=$(grep -Eo '"sha256"[[:space:]]*:[[:space:]]*"[a-fA-F0-9]{64}"' "$_mf" | grep -Eo '[a-fA-F0-9]{64}' | tr 'A-F' 'a-f' | sort -u)
  _count=$(printf '%s\n' "$_digests" | sed '/^$/d' | wc -l | tr -d '[:space:]')
  if [ "$_count" != "1" ]; then
    printf '%s\n' "manifest 摘要字段畸形（唯一 sha256 要求，实际 $_count）" >&2
    return 1
  fi
  printf '%s\n' "$_digests"
  return 0
}

# Archive entry checks before extract (I-07): absolute, .., drive/colon,
# backslash, symlinks, hardlinks, and other non-regular types.
# Does not extract. Uses tar listing type letters from `tar -tvzf`.
validate_archive_entries() {
  _archive=$1
  _names=$2
  _verbose=$3
  if ! tar -tzf "$_archive" > "$_names" 2>/dev/null; then
    printf '%s\n' "无法列出归档条目" >&2
    return 1
  fi
  if grep -E '(^/|(^|/)\.\.(/|$)|\\|:)' "$_names" >/dev/null 2>&1; then
    printf '%s\n' "归档含不安全路径（绝对路径/上级目录/反斜杠/冒号）" >&2
    return 1
  fi
  if ! tar -tvzf "$_archive" > "$_verbose" 2>/dev/null; then
    printf '%s\n' "无法检查归档条目类型" >&2
    return 1
  fi
  # portable: first field of each line begins with type letter (GNU/bsdtar)
  if awk '
    NF == 0 { next }
    {
      t = substr($1, 1, 1)
      if (t != "-" && t != "d") {
        bad = 1
        exit 1
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$_verbose"; then
    :
  else
    printf '%s\n' "归档含符号链接/硬链接/特殊条目，已拒绝" >&2
    return 1
  fi
  return 0
}

extract_archive_safely() {
  _archive=$1
  _dest=$2
  mkdir -p "$_dest"
  tar -xzf "$_archive" -C "$_dest" || {
    printf '%s\n' "解压失败（可能磁盘不足或归档损坏）" >&2
    return 1
  }
}

# Formal downloaded bundle must ship runtime Node (I-05). --source (dev) may use system Node.
resolve_node() {
  _src=$1
  if [ -x "$_src/runtime/node" ]; then
    node_bin="$_src/runtime/node"
    return 0
  fi
  if [ "$source_mode" -eq 1 ]; then
    node_bin=$(command -v node 2>/dev/null) || {
      printf '%s\n' "开发 --source 模式需要 Node 运行时" >&2
      exit 40
    }
    return 0
  fi
  printf '%s\n' "安装包不完整：缺少内置 Node 运行时（不会回退到系统 Node）" >&2
  exit 20
}

download_one() {
  # $1 url $2 out
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 600 \
    -o "$2" "$1" || {
      printf '%s\n' "下载失败：$1" >&2
      return 1
    }
}

prepare_from_release() {
  assert_supported_target
  resolve_version_once
  command -v curl >/dev/null 2>&1 || {
    printf '%s\n' "缺少 curl" >&2
    exit 40
  }
  command -v tar >/dev/null 2>&1 || {
    printf '%s\n' "缺少 tar" >&2
    exit 40
  }
  base="https://github.com/zephyrw/dev-flow/releases/download/$version"
  asset="devflow-$version-$target.tar.gz"
  manifest_name="release-$target.json"
  temp=$(mktemp -d)
  trap 'cleanup' EXIT HUP INT TERM

  download_one "$base/$manifest_name" "$temp/$manifest_name" || exit 20
  download_one "$base/$manifest_name.sha256" "$temp/$manifest_name.sha256" || exit 20
  expected_manifest=$(awk 'NR==1 {print $1}' "$temp/$manifest_name.sha256")
  actual_manifest=$(sha256_of "$temp/$manifest_name")
  if [ "$expected_manifest" != "$actual_manifest" ]; then
    printf '%s\n' "manifest SHA-256 校验失败" >&2
    exit 20
  fi
  expected_asset_sha=$(validate_manifest_file "$temp/$manifest_name" "$target" "$version") || exit 20

  download_one "$base/$asset" "$temp/$asset" || exit 20
  download_one "$base/$asset.sha256" "$temp/$asset.sha256" || exit 20
  expected_sidecar=$(awk 'NR==1 {print $1}' "$temp/$asset.sha256" | tr 'A-F' 'a-f')
  actual=$(sha256_of "$temp/$asset")
  if [ "$expected_sidecar" != "$actual" ] || [ "$expected_asset_sha" != "$actual" ]; then
    printf '%s\n' "发布包 SHA-256 校验失败" >&2
    exit 20
  fi

  if ! validate_archive_entries "$temp/$asset" "$temp/entries" "$temp/verbose"; then
    exit 20
  fi
  mkdir -p "$temp/bundle"
  if ! extract_archive_safely "$temp/$asset" "$temp/bundle"; then
    exit 20
  fi
  source_dir="$temp/bundle/devflow"
  if [ ! -d "$source_dir" ]; then
    printf '%s\n' "安装包不完整：缺少 devflow 根目录" >&2
    exit 20
  fi
}

capture_setup_url() {
  # Prefer the installer's printed setup URL; fall back to devflow.yaml / human origin.
  setup_url=$(printf '%s\n' "$1" | sed -n 's/^首次设置页面：//p' | head -n 1)
  if [ -z "$setup_url" ] && [ -f "$install_dir/devflow.yaml" ]; then
    setup_url=$(sed -n 's/.*"human_origin"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$install_dir/devflow.yaml" | head -n 1)
  fi
}

open_setup_page() {
  _url=$1
  if [ "$no_open" -eq 1 ]; then
    printf '%s\n' "DevFlow 已安装。请访问下方地址完成设置，或运行 \`devflow\` 打开。"
    printf '%s\n' "$_url"
    return 0
  fi
  _ok=1
  case "$platform" in
    darwin)
      if command -v open >/dev/null 2>&1; then
        open "$_url" >/dev/null 2>&1 || _ok=0
      else
        _ok=0
      fi
      ;;
    linux)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$_url" >/dev/null 2>&1 || _ok=0
      else
        _ok=0
      fi
      ;;
    *)
      _ok=0
      ;;
  esac
  if [ "$_ok" -eq 1 ]; then
    printf '%s\n' "DevFlow 已安装，并已打开设置页面。选择你要使用的编程助手和模型，即可开始。"
  else
    # plan §6.1 browser fallback copy
    printf '%s\n' "DevFlow 已安装。浏览器未能自动打开，请访问下方地址，或运行 \`devflow\` 再次打开。"
    printf '%s\n' "$_url"
  fi
}

run_installer_and_map_exit() {
  _entry="$source_dir/dist/packages/installer/src/main.js"
  if [ ! -f "$_entry" ]; then
    if [ "$source_mode" -eq 1 ]; then
      printf '%s\n' "开发 --source 需要完整构建产物（缺少 $_entry）；请先执行 pnpm install --frozen-lockfile 和 pnpm build。这不是 clone 自动构建入口。" >&2
    else
      printf '%s\n' "安装包不完整：缺少安装器入口" >&2
    fi
    exit 20
  fi
  set -- --source "$source_dir" --install-dir "$install_dir"
  # Default install does not force a client (plan §4.4). Advanced --tool/--tools still works.
  if [ "$tools_explicit" -eq 1 ]; then
    set -- "$@" --tools "$selected_tools"
  fi
  [ -n "$planner_tool" ] && set -- "$@" --planner-tool "$planner_tool"
  [ -n "$planner_model" ] && set -- "$@" --planner-model "$planner_model"
  [ -n "$planner_effort" ] && set -- "$@" --planner-effort "$planner_effort"
  [ -n "$executor_tool" ] && set -- "$@" --executor-tool "$executor_tool"
  [ -n "$executor_model" ] && set -- "$@" --executor-model "$executor_model"
  [ -n "$executor_effort" ] && set -- "$@" --executor-effort "$executor_effort"

  set +e
  _out=$("$node_bin" "$_entry" "$@" 2>&1)
  _code=$?
  set -e
  printf '%s\n' "$_out"

  setup_pending=0
  # Model/tool setup is onboarding for default installs (plan §4.4, S07).
  # Exit code 10 keeps its installer meaning for direct/internal callers.
  if [ "$_code" -eq 10 ]; then
    if [ "$require_ready" -eq 1 ]; then
      printf '%s\n' "严格就绪检查未通过：工具/模型设置未完成（exit 10）" >&2
      capture_setup_url "$_out"
      exit 10
    fi
    setup_pending=1
    _code=0
  fi
  if [ "$_code" -ne 0 ]; then
    exit "$_code"
  fi
  capture_setup_url "$_out"
  if [ -z "$setup_url" ]; then
    setup_url="http://localhost:4810"
  fi
  open_setup_page "$setup_url"
  if [ "$setup_pending" -eq 1 ]; then
    printf '%s\n' "模型设置待完成（不影响本次软件安装）。"
  fi
}

main() {
  parse_args "$@"
  # OS/arch always detected (node naming + clear I-08 errors). Target matrix
  # enforced only before downloading a release bundle.
  detect_os
  detect_arch
  if [ "$source_mode" -eq 1 ]; then
    if [ -z "$source_dir" ]; then
      usage_error "--source 需要目录参数"
    fi
    if [ ! -d "$source_dir" ]; then
      printf '%s\n' "源目录不存在：$source_dir" >&2
      exit 20
    fi
    source_dir=$(cd "$source_dir" && pwd)
  else
    prepare_from_release
    source_dir=$(cd "$source_dir" && pwd)
  fi
  resolve_node "$source_dir"
  run_installer_and_map_exit
}

if [ "${DEVFLOW_INSTALL_TEST_LIB:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
main "$@"
