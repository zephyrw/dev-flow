#!/bin/zsh
# 仅迁移已核验的 gemini / antigravity 条目；不读取或输出登录凭据。
# 保留已存在的 Node 签名分区，并补齐官方 Apple security 工具分区。
# 密码由 Apple security 在本机交互读取，不进入脚本、命令参数或日志。
/usr/bin/security set-generic-password-partition-list \
  -s gemini -a antigravity \
  -S 'teamid:HX7739G8FX,apple-tool:' \
  "$HOME/Library/Keychains/login.keychain-db"
repair_exit=$?
if (( repair_exit == 0 )); then
  print '旧条目的签名权限已修复；请返回 DevFlow 继续验证。'
else
  print '系统确认未完成，现有登录凭据未被此脚本改写。'
fi
exit $repair_exit
