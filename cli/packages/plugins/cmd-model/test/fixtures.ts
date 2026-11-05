/**
 * Golden fixtures captured from the real magpie CLI on this machine
 * (magpie.exe, 2026-11) — the same captures tool-magpie tests against.
 */

/** `magpie ls` — real output (trimmed to the rows the tests need). */
export const MAGPIE_LS = `  Claude Code                    —  ·  effort xhigh                                   ~\\.claude\\settings.json
  Codex                          kimi-code-cn/k3  ·  effort high                      ~\\.codex\\config.toml
  OpenCode                       magpie/codex/gpt-6-luna  ·  small —                  ~\\.config\\opencode\\opencode.json
  DeepSeek Harness               magpie/group/claude-cheap  ·  thinking high          ~\\.dsh\\profiles\\web\\cordis.patch.yml
  omp                            magpie/gemini/gemini-3.1-pro-preview  ·  thinking —  ~\\.omp\\agent\\config.yml
  Kimi Code                      kimi-code/k3.1-pro                                   ~\\.kimi-code\\config.toml
  Alma                           magpie/group/group                                   http://localhost:23001
  DeepSeek Harness · WSL Ubuntu  magpie/group/smart-split  ·  thinking —              \\\\wsl.localhost\\Ubuntu\\root\\.dsh\\profiles\\mola\\cordis.patch.yml
`;

/** `magpie dsh` — real output for one agent. */
export const MAGPIE_DSH = `  DeepSeek Harness  magpie/group/claude-cheap  ·  thinking high  ~\\.dsh\\profiles\\web\\cordis.patch.yml
`;

/** `magpie models` — the global route list, trimmed. */
export const MAGPIE_MODELS = `  Routing groups
  group/smart-split                                                  难题给强模型，简单的给便宜模型
  group/forcp                                                        forcp  low/high
  group/claude-cheap                                                 claude-cheap  high
  auto/kimi-k3                                                       Kimi K3  low/high
  auto/deepseek-v4-flash                                             DeepSeek V4 Flash  high
  DeepSeek
  deepseek/deepseek-v4-pro[1M]  DeepSeek V4 Pro [1M]  none/low/high/max
`;

/** magpie's dated stderr log noise, verbatim (dropped by stripLogNoise). */
export const MAGPIE_STDERR_NOISE = `2026/11/05 00:24:25 plugin [error]: github:mu-zi-lee/magpie-our-free-model: provider.models: 数据目录已被另一个服务占用；关闭那个服务或使用另一个 managed.dataDir。
2026/11/05 00:24:26 plugin: kimi-work: DescribeKimiWorkConfig with the web sign-in failed (HTTP 401); asking it without one
`;
