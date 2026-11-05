/**
 * Golden fixtures captured from the real magpie CLI on this machine
 * (magpie.exe, 2026-11). Used verbatim by the tests so the parsers are
 * checked against magpie's actual table shapes, not invented ones.
 */

/** `magpie ls` — real output (23 rows, CRLF-free, two-space indent). */
export const MAGPIE_LS = `  Claude Code                    —  ·  effort xhigh                                   ~\\.claude\\settings.json
  Claude Desktop                 provider —                                           ~\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Local\\Claude\\claude_desktop_config.json
  Codex                          kimi-code-cn/k3  ·  effort high                      ~\\.codex\\config.toml
  Antigravity CLI                Claude Sonnet 4.6 (Thinking)                         ~\\.gemini\\antigravity-cli\\settings.json
  Antigravity                    —  ·  effort —                                       ~\\.antigravity\\settings.json
  OpenCode                       magpie/codex/gpt-6-luna  ·  small —                  ~\\.config\\opencode\\opencode.json
  Pi                             magpie/grok/grok-4.7  ·  thinking —                  ~\\.pi\\agent\\settings.json
  OmO                            —  ·  thinking —                                     ~\\.omo\\agent\\settings.json
  VS Code                        magpie/gemini/gemini-3.8-flash                       ~\\AppData\\Roaming\\Code\\User\\settings.json
  DeepSeek Harness               magpie/group/claude-cheap  ·  thinking high          ~\\.dsh\\profiles\\web\\cordis.patch.yml
  omp                            magpie/gemini/gemini-3.1-pro-preview  ·  thinking —  ~\\.omp\\agent\\config.yml
  Devin                          —  ·  effort —                                       ~\\AppData\\Roaming\\devin\\config.json
  Kimi Code                      kimi-code/k3.1-pro                                   ~\\.kimi-code\\config.toml
  Qwen Code                      —                                                    ~\\.qwen\\settings.json
  Muse Code                      —                                                    ~\\.config\\muse\\settings.json
  OpenClaw                       —                                                    ~\\.openclaw\\openclaw.json
  Cline                          deepseek-v4-pro  ·  effort xhigh                     ~\\.cline\\data\\settings\\providers.json
  Grok Build                     —  ·  effort —                                       ~\\.grok\\config.toml
  ZCode                          provider —                                           ~\\.zcode\\v2\\config.json
  WorkBuddy                      provider —                                           ~\\workbuddy\\models.json
  CodeBuddy                      —                                                    ~\\.codebuddy\\models.json
  Alma                           magpie/group/group                                   http://localhost:23001
  DeepSeek Harness · WSL Ubuntu  magpie/group/smart-split  ·  thinking —              \\\\wsl.localhost\\Ubuntu\\root\\.dsh\\profiles\\mola\\cordis.patch.yml
`;

/** `magpie dsh` — real output for one agent. */
export const MAGPIE_DSH = `  DeepSeek Harness  magpie/group/claude-cheap  ·  thinking high  ~\\.dsh\\profiles\\web\\cordis.patch.yml
`;

/** `magpie models dsh` — real output, trimmed below the visible-set lines
 * (the parser only reads the route rows and the "is shown" line). */
export const MAGPIE_MODELS_DSH = `  Routing groups
  group/smart-split             难题给强模型，简单的给便宜模型
  group/forcp                   forcp  low/high
  group/group-2                 无监管  max
  group/claude-cheap            claude-cheap  high
  group/claude-ultra            claude-ultra  low/medium/high
  auto/deepseek-v4-flash        DeepSeek V4 Flash  high
  auto/deepseek-v4-pro          DeepSeek V4 Pro  high
  auto/claude-sonnet-5-5        Claude Sonnet 5.5  low/medium/high/xhigh/max
  auto/claude-opus-5-5          Claude Opus 5.5  low/medium/high
  auto/gpt-6-luna               GPT-6 Luna  low/medium/high/xhigh/max
  auto/kimi-k3                  Kimi K3  low/high
  auto/gemini-3.8-flash         Gemini 3.8 Flash  low/medium/high
  auto/minimax-m3.1-flash       MiniMax-M3.1-Flash  low/high/xhigh
  auto/minimax-m3               MiniMax-M3  none/high
  DeepSeek
  deepseek/deepseek-v4-pro[1M]  DeepSeek V4 Pro [1M]  none/low/high/max
  deepseek/deepseek-flash       DeepSeek-V4.1-Flash  none/low/high/max
  deepseek/deepseek-v4-flash    DeepSeek V4 Flash  none/low/high/max
  deepseek/deepseek-v4-pro      DeepSeek-V4-Pro  none/low/high/max
  dsh is shown smart-split, forcp, group-2, claude-cheap, claude-ultra, auto-deepseek-v4-pro, auto-deepseek-v4-flash, auto-kimi-k3, auto-minimax-m3, auto-minimax-m3-1-flash, auto-gemini-3-8-flash, auto-claude-opus-5-5, auto-claude-sonnet-5-5, auto-gpt-6-luna, deepseek
  ! 309 kept from dsh, in none of those:
    no family · group: group/group
    no family · auto-glm-5-3: auto/glm-5.3
    no family · auto-k3: auto/k3
  Kimi For Coding: 4 more models in its list, not exposed (not picked): kimi-for-coding, kimi-for-coding-highspeed, k3-256k, k3.1-pro-highspeed
`;

/** `magpie models` (no agent) — the global route list, trimmed. */
export const MAGPIE_MODELS = `  Routing groups
  group/smart-split                                                  难题给强模型，简单的给便宜模型
  group/forcp                                                        forcp  low/high
  group/group-2                                                      无监管  max
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

/** omp's real crash output (Bun SyntaxError, adapters-routing §2.9). */
export const OMP_CRASH = `SyntaxError: Unexpected identifier 'c'
      at <parse> (C:\\Users\\22494\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js:134:1)

Bun v1.3.11 (Windows x64)
`;
