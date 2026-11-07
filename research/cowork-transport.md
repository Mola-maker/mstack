# Cowork 传输方案调研：中国大陆多机互联（Outcome 视角）

调研日期：2026-11-06。标记说明：**[M]** 我方实测；**[P]** 官方文档原文（已抓取）；**[A]** 社区/博客个人经验，未复现；**[U]** 未验证（搜索摘要或推断）。

## 方案对照表

| method | measured outcome | setup cost | fits which link | source |
|---|---|---|---|---|
| Tailscale 默认 DERP（海外） | 本机 Windows→Ubuntu 经 HK DERP 677 ms，无直连 [M]；Issue #3430 中国用户经默认 DERP 延迟极高，维护者归因 GFW，v1.20 后报告"已正常"（Feb 2022） [P][A] | 0（已部署） | 任何无直连场景的兜底 | https://github.com/tailscale/tailscale/issues/3430 |
| Tailscale 自建 DERP（custom） | 博客称国内自建 relay 约 20 ms、HK 节点 100 ms+ [A]；无本项目对照数据 | 需域名、HTTPS 443、STUN 3478，并在 tailnet policy 写 `derpMap`（region 900–999）；官方标注 **alpha** [P] | 设备间直连失败、需要就近中继 | https://tailscale.com/kb/1118/custom-derp-servers |
| DERP `--verify-clients` | 仅允许本 tailnet 设备使用，防止中继被滥用 [P] | 启动参数一条；需同机运行 tailscaled [P] | 公网中继必开 | 同上 |
| Tailscale 直连 NAT 穿透 | 官方称典型条件下直连成功率"well north of 90%"（2025-10） [P] | 0 | 家宽↔家宽、家宽↔云 | https://tailscale.com/blog/nat-traversal-improvements-pt-1 |
| Tailscale NAT 类型矩阵 | Easy+Easy 直连；任一端 Hard NAT（对称）即中继 [P] | 诊断用 `tailscale netcheck`（看 UDP 字段与 MappingVariesByDestIP） [P] | 诊断校园网 | https://tailscale.com/kb/1411/device-connectivity |
| 对称 NAT / 校园网出口 | 对称 NAT 每个目的地端口不同，"virtually impossible" 直连 [P]；浙大校园网按目的地分流非对称路由 [A] | 需网管配合或换 IPv6 / 出口 | 校园网 ↔ 任意 | 同上；https://mkmark.github.io/blog/work/asymmetric-routing-and-campus-firewall |
| UPnP / NAT-PMP / PCP 端口映射 | 可让 Tailscale 直连；官方警告会"allow in and forward all traffic" [P] | 路由器开启，有安全代价 | 家用路由器 | https://tailscale.com/blog/nat-traversal-improvements-pt-1 |
| Headscale（控制面自托管） | 无国内实测数据；控制面不改变中继位置，仍用 DERP [U] | 中等（需公网控制面 + DERP） | 想去掉 Tailscale 账号依赖时 | https://www.bigiron.cc/guides/netbird-vs-headscale-the-open-source-tailscale-control-planes |
| NetBird（signal + coturn） | 无国内实测；TURN 中继同样需要可达的公网节点 [U] | 中高（signal、management、coturn 三件） | 同上 | https://wz-it.com/en/blog/netbird-vs-zerotier-vpn-alternative/ |
| ZeroTier 私有 moon | 博客称国内部署 moon 后 20–50 ms [A]；官方"强烈不建议"新建私有 moon，且无 SLA [P/U，来自搜索摘要] | 中（UDP 9993 单端口） | 不推荐新建 | https://docs.zerotier.com/roots/ ；https://rayriffy.com/garden/zerotier-moon |
| EasyTier 公共节点 | 支持 TCP/UDP/WSS/WG，P2P 失败时经公共节点中转；官方称 NAT4-NAT4 可通 [P 自述，未独立验证]；无延迟数据，README 中 3.45 ms / 27.8 ms 仅为示例输出 | 低（单二进制，`--network-name` + `--network-secret` 即公共节点） | 中继备用、非 Tailscale 客户端场景 | https://github.com/EasyTier/EasyTier |
| EasyTier 在国内运营商 | V2EX 用户称广东电信阻断 P2P，只能中继 [A] | — | 需实测 | https://www.v2ex.com/t/1121167 （搜索结果链接，未抓取全文） |
| frp / rathole 反向隧道（公网 VM 中转） | rathole 官方 benchmark（2021-12，单机 127.0.0.1）：1 QPS 时 2.11 ms vs frp 2.55 ms；4000 QPS 时 frp 7907 ms [P]。无真实公网数据 | 低–中（每端一个进程，需公网 VM） | 只需单向访问（如 SSH、HTTP）；不做设备互联 | https://github.com/rapiz1/rathole/blob/main/docs/benchmark.md |
| QUIC/UDP 代理（Hysteria2 / sing-box 类） | 无系统实测；V2EX 反馈白天好、晚高峰不稳，UDP 疑被 QoS [A] | 中（需公网 VM + 证书，UDP/443） | 跨境出口代理，不是设备互联方案 | https://lilting.ch/en/articles/hysteria2-server-client-overview |
| NATS leaf node | 出站拨号到 hub，本地无需公网入站 [P]；断链期间缓冲/本地运行行为文档未写明 [U] | 中（hub 需可达） | 发布/订阅类控制消息，弱网 | https://docs.nats.io/running-a-nats-service/configuration/leafnodes |
| GitHub 直接 clone | 博客称约 20 KB/s 上限 [A]；中国服务器访问 github.com 出现 504 [A] | 0 | 不可作为唯一代码通道 | https://besthub.dev/articles/boost-git-clone-speed-in-china-use-gitee-to-download-at-1-2-mb-s-6d515baa6836 |
| Gitee 镜像 | 博客称 1–2 MB/s，无测量依据 [U]；镜像有审查风险 [A] | 低（需同步 + submodule URL 改写） | 中国大陆拉取 | 同上 |
| 自建 Gitea | 无国内实测 [U] | 中（一台可达服务器 + 备份） | 内网私有仓库，仍需穿透到达 | — |
| Cloudflare R2 作异步投递箱 | 中国访问质量不稳定（厂商 FAQ 自述，非独立测试） [A]；r2.dev 有限速，生产用自定义域名 [A] | 低 | 异步大文件，不作实时通道 | https://docs.apiyi.com/faq/cdn-download-slow |
| 阿里云 OSS / 腾讯云 COS 投递箱 | 国内访问快；绑定公网域名需 ICP 备案 [A/U]，未实测 | 低–中（备案周期） | 大文件异步 | — |
| IM / 邮件作控制通道 | 无测量；适合告警与指令级消息，不适合数据面 [U] | 低 | 任何链路的最终兜底控制面 | — |

## 对 Cowork 设计的教训（5–8 条）

1. **先诊断再换方案。** 677 ms 经 HK DERP 且无直连，先跑 `tailscale netcheck` 两端：UDP 为 false 或 MappingVariesByDestIP 为 true 分别对应"UDP 被封"与"对称 NAT"，修法不同 [P]。
2. **中继位置决定延迟上限。** 默认 DERP 在海外；与 Issue #3430 同类症状常见于"家庭节点选了远端 home DERP"。自建 DERP 的收益只在"直连失败"时出现，直连成功则 DERP 不转发数据 [P]。
3. **自建 DERP 的 ICP 是隐性成本。** 官方要求域名 [P]。国内云 80/443 对外服务通常需备案 [A/U]，可评估 HK 或已有 LA VM（无备案）+ DERP 的 HTTPS 端口改为非 443（官方允许 `DERPPort` 修改 [P]），但"改端口可绕备案"仅见社区说法 [A]，需在云厂商处确认。
4. **DERP 必须 verify-clients。** 公网中继不开鉴权等于开放中继 [P]。
5. **不要把 moon 或 Hysteria 当主通道。** moon 官方已不推荐新建 [P/U]；Hysteria 只有个人经验 [A]，缺乏可复现数字。
6. **数据面与控制面分开。** 大文件走对象存储或 Gitee/Gitea 异步；实时控制（启动、停止、告警）走 NATS leaf 或 IM，小消息、低带宽容忍。
7. **所有"国内 X ms"数字都当作待测。** 本次检索中几乎所有国内延迟数字都来自单篇博客或帖子。上线前必须在目标运营商网络上做 `tailscale ping` / `netcheck` 前后对照（建议至少晚高峰一次）。
8. **验证节点可用性用"两端同时测"。** 单端 ping 不能证明中继在用哪个 DERP，要看 `tailscale status` 的 relay 字段与 `netcheck` 的 region 延迟。

## 推荐顺序

- **主通道：** Tailscale 直连。先修 NAT（netcheck 诊断，校园网试 IPv6，家用路由器可考虑端口映射但注意安全）。
- **主中继（若直连仍失败）：** 自建 DERP，选无需备案的非大陆节点（HK 或已有 LA VM），`--verify-clients`，写入 `derpMap` 并删去默认高延迟 region（`"OmitDefaultRegions"` 视需要），改前改后各测一次。
- **数据面备用：** EasyTier 公共节点（不依赖 Tailscale 账号），或 frp 单向暴露必要服务。
- **异步备用：** Gitee 镜像（代码）+ 对象存储（大文件）。
- **控制面兜底：** NATS leaf（有 hub 可达时）或 IM 告警。

## 未完成与风险

- 未做任何真实链路实测（除已有的 677 ms 与 Issue 数据外）。上表 [A]/[U] 项不可用于决策。
- 未验证：Aliyun / Tencent 对非 80/443 端口 DERP 的备案规则；NATS leaf 断链缓冲行为；EasyTier 在国内运营商的 P2P 成功率。
- 信息源多为中文博客、V2EX 与 AI 生成内容，注意去重核对。
- GitHub MCP 连接失败，本次未通过 `gh` 查证相关仓库状态。
