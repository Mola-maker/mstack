# 02 · 网络

## 层次

```
手机/平板 ──(Tailscale / P2P E2E)──┐
                                   ├── mesh 内设备互通（tail）
开发机 ×4 ─────────(Tailscale)─────┘
        └──(ssh over tailnet)──> 阿里云 / 腾讯云 / LA
                                          └──(queqiao QUIC)── 跨太平洋长链路
```

## 组件

| 需求 | 方案 | 部署位置 | 备注 |
|---|---|---|---|
| 设备互联 | Tailscale | 全部 | 已在用 |
| 国内中继 | 自建 DERP | 阿里云 | 减少走海外官方 DERP 的延迟 |
| 出海出口 | Tailscale exit node + 3X-UI | LA | LA 机只放轻量服务 |
| 长链路优化 | [bojieli/queqiao](https://github.com/bojieli/queqiao) | LA ↔ 国内云 | QUIC，丢包当纠删处理，TLS/TCP 回退 |
| UDP 被限时兜底 | [udp2raw](https://github.com/wangyu-/udp2raw) / [wg-quic](https://github.com/RC-CHN/wg-quic) | 视情况 | 仅在 WireGuard UDP 受限时启用 |
| 代理配置参考 | [personal-edge-proxy](https://github.com/yding-git/personal-edge-proxy) | — | Xray / Hysteria2 / REALITY 参考 |
| SSH 客户端 | [Hatoba](https://github.com/scarletkc/Hatoba) | main | 自己的 Cloudflare 账号做 E2E 同步 |
| 流量排查 | mitmproxy | main | 调试 agent / bot 请求 |
| 端口与存活监控 | 待定（Uptime Kuma 等） | 腾讯云 | 对应草图 "Listening port" |

## 注意

- star 列表中的 `MetaCubeX/mihomo` 是星铁数据 Python 库，**不是** Clash 内核。
- 云服务器 SSH 只走 tailnet，公网 22 端口关闭（待落地）。
