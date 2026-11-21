#!/usr/bin/env bash
# sha256 的兼容实现：Linux 有 sha256sum，macOS 默认只有 shasum；两个都没有返回 1（不输出）。
# _lib.sh（配置指纹）和 review-scope.sh（方案指纹，GitHub#621）共用这一份。标准输入 → 64 位十六进制。
cfg_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
    else return 1; fi
}
