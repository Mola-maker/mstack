import React from "react";
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

// Tokens mirror cli/packages/plugin-sdk/src/theme.ts (THEME / SEMANTIC) so the animation matches the real console.
const T = {
  blue: { 50: "#f7fbff", 100: "#eaf3ff", 300: "#b7d4ff", 500: "#5d93dc", 600: "#3f72bd", 700: "#2b5597" },
  pink: { 100: "#fde8f1", 300: "#f2a5c4", 500: "#dd668d" },
  ink: { 900: "#1f2c44", 600: "#4a5b78", 500: "#586884", 400: "#8496b3" },
  night: { 900: "#0f1726", 800: "#172238", 700: "#22314e" },
  lift2: "inset 0 1px 0 rgba(255,255,255,.85), 0 10px 29px rgba(52,101,170,.14)",
  lift3: "inset 0 1px 0 rgba(255,255,255,.85), 0 15px 35px rgba(52,101,170,.19)",
};
const BG = T.night[900];
const FG = "#e8f0ff";
const DIM = "#8ea1c4";
const LINE = "#33466b";
const MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', monospace";
const SANS = "'Zen Maru Gothic', 'Yu Gothic UI', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

const SCENES = { title: 60, route: 150, web: 240, tui: 120, cua: 120, end: 90 };
export const DURATION = Object.values(SCENES).reduce((a, b) => a + b, 0);

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ramp = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], clamp);

// Fade in at the start of a scene and out at its end.
const useFade = (len: number) => {
  const f = useCurrentFrame();
  return interpolate(f, [0, 12, len - 12, len], [0, 1, 1, 0], clamp);
};

const Caption: React.FC<{ children: React.ReactNode; dark?: boolean }> = ({ children, dark }) => (
  <div style={{ position: "absolute", bottom: 40, width: "100%", textAlign: "center", color: dark ? T.ink[500] : DIM, fontFamily: SANS, fontSize: 26 }}>
    {children}
  </div>
);

type PillState = "done" | "now" | "todo";
const Pill: React.FC<{ label: string; state: PillState }> = ({ label, state }) => (
  <div
    style={{
      fontFamily: MONO, fontSize: 20, padding: "6px 16px", borderRadius: 999, whiteSpace: "nowrap",
      border: `1px solid ${state === "todo" ? T.blue[300] : T.blue[600]}`,
      background: state === "now" ? T.blue[600] : state === "done" ? T.blue[100] : "#fff",
      color: state === "now" ? "#fff" : state === "done" ? T.blue[700] : T.ink[400],
    }}
  >
    {state === "done" ? "✓ " : state === "now" ? "▸ " : "○ "}{label}
  </div>
);

const Title = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: useFade(SCENES.title) }}>
      <div style={{ fontFamily: MONO, fontSize: 120, color: FG, transform: `translateY(${(1 - s) * 20}px)` }}>mstack</div>
      <div style={{ fontFamily: SANS, fontSize: 32, color: DIM, marginTop: 12, opacity: s }}>
        一句话交给 agent，自己只管点头
      </div>
    </AbsoluteFill>
  );
};

const STAGES = ["think", "plan", "implement", "verify", "review", "ship"];

// 1. /go <一句话> -> the six stages light up one by one
const Route = () => {
  const f = useCurrentFrame();
  const full = "/go 给首页英雄区加上滚动视差";
  const typed = full.slice(0, Math.floor(interpolate(f, [6, 46], [0, full.length], clamp)));
  const active = Math.floor(interpolate(f, [56, 138], [0, STAGES.length - 0.01], clamp));
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.route) }}>
      <div style={{ position: "absolute", top: 150, left: 140, fontFamily: MONO, fontSize: 38, color: FG }}>
        <span style={{ color: T.pink[300] }}>&gt; </span>{typed}<span style={{ opacity: f % 30 < 15 ? 1 : 0 }}>▍</span>
      </div>
      <div style={{ position: "absolute", top: 330, left: 60, right: 60, display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
        {STAGES.map((s, i) => {
          const on = f >= 56 && i === active;
          const done = f >= 56 && i < active;
          return (
            <React.Fragment key={s}>
              <div style={{
                fontFamily: MONO, fontSize: 25, padding: "12px 20px", borderRadius: 16,
                border: `1px solid ${on || done ? T.blue[500] : T.night[700]}`,
                color: on ? "#fff" : done ? T.blue[300] : DIM,
                background: on ? T.blue[600] : T.night[800],
                boxShadow: on ? "0 10px 29px rgba(63,114,189,.45)" : "none",
                transform: `translateY(${on ? -6 : 0}px)`,
              }}>{done ? "✓ " : ""}{s}</div>
              {i < STAGES.length - 1 && <span style={{ color: DIM, fontFamily: MONO, fontSize: 24 }}>→</span>}
            </React.Fragment>
          );
        })}
      </div>
      <Caption>mola go：从想法到上线，六个阶段自己往下走</Caption>
    </AbsoluteFill>
  );
};

// 2. mola web: run cards + approval + side panel (day theme)
const Card: React.FC<{ style?: React.CSSProperties; children: React.ReactNode }> = ({ style, children }) => (
  <div style={{ background: "#fff", borderRadius: 24, boxShadow: T.lift2, padding: "22px 28px", ...style }}>{children}</div>
);

const LADDER: [string, string, "ok" | "gap" | "need"][] = [
  ["L5", "性能与体积", "gap"], ["L4", "走通行为", "gap"], ["L3", "装上并启动（要求）", "need"], ["L2", "单元测试", "gap"], ["L1", "能编译", "ok"],
];
const RUN_STAGES = ["plan", "implement", "verify", "review", "ship"];

const Web = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = (d: number): React.CSSProperties => {
    const s = spring({ frame: f - d, fps, config: { damping: 200 } });
    return { opacity: s, transform: `translateY(${(1 - s) * 24}px)` };
  };
  const press = ramp(f, 150, 160) - ramp(f, 185, 200);
  const approved = f >= 158;
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.web), background: T.blue[50] }}>
      <div style={{ position: "absolute", top: 34, left: 60, fontFamily: SANS, fontSize: 34, fontWeight: 700, color: T.ink[900] }}>
        mola 控制台 <span style={{ fontSize: 20, fontWeight: 400, color: T.blue[600], marginLeft: 14 }}>已连接</span>
      </div>
      <div style={{ position: "absolute", top: 100, left: 60, width: 700 }}>
        <div style={pop(10)}>
          <Card style={{ boxShadow: T.lift3, borderBottom: `8px solid ${T.pink[300]}` }}>
            <div style={{ fontFamily: SANS, fontSize: 25, fontWeight: 700, color: T.ink[900] }}>给首页的英雄区加上滚动视差</div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              {RUN_STAGES.map((s, i) => <Pill key={s} label={s} state={i < 4 ? "done" : "now"} />)}
            </div>
            <div style={{ fontFamily: SANS, fontSize: 20, color: T.ink[500], marginTop: 12 }}>
              {approved ? "已批准 · 正在推送" : "等你 · ship · 已用 3 分钟"}
            </div>
            <div style={{ marginTop: 14, borderRadius: 16, background: T.pink[100], padding: "16px 20px", ...pop(55) }}>
              <div style={{ fontFamily: SANS, fontSize: 23, color: T.ink[900] }}>要你点头：git push … 并开 PR</div>
              <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                <div style={{
                  fontFamily: SANS, fontSize: 22, padding: "8px 28px", borderRadius: 999, color: "#fff",
                  background: T.blue[600], boxShadow: `0 ${6 - 4 * press}px 14px rgba(63,114,189,.35)`, transform: `translateY(${press * 3}px)`,
                }}>{approved ? "已批准" : "批准"}</div>
                <div style={{ fontFamily: SANS, fontSize: 22, padding: "8px 28px", borderRadius: 999, background: "#fff", color: T.pink[500], border: `1px solid ${T.pink[300]}` }}>拒绝</div>
              </div>
            </div>
          </Card>
        </div>
        <div style={{ marginTop: 26, ...pop(30) }}>
          <Card style={{ padding: "18px 28px" }}>
            <div style={{ fontFamily: SANS, fontSize: 23, fontWeight: 700, color: T.ink[900] }}>给 CAD2GIS 的图层匹配补单元测试</div>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              {RUN_STAGES.map((s, i) => <Pill key={s} label={s} state={i === 0 ? "done" : i === 1 ? "now" : "todo"} />)}
            </div>
          </Card>
        </div>
      </div>
      <div style={{ position: "absolute", top: 100, left: 810, width: 410 }}>
        <div style={pop(80)}>
          <Card style={{ padding: "20px 26px" }}>
            <div style={{ fontFamily: SANS, fontSize: 25, fontWeight: 700, color: T.ink[900] }}>只验到 L1，要求 L3</div>
            <div style={{ marginTop: 14 }}>
              {LADDER.map(([lv, label, st]) => (
                <div key={lv} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, fontFamily: SANS, fontSize: 20, color: st === "need" ? T.ink[900] : T.ink[500] }}>
                  <div style={{
                    width: 54, height: 26, borderRadius: 10, flexShrink: 0, boxSizing: "border-box",
                    background: st === "ok" ? T.blue[500] : st === "need" ? "#fff" : T.blue[100],
                    border: st === "need" ? `2px dashed ${T.pink[500]}` : "none",
                  }} />
                  {lv} {label}
                </div>
              ))}
            </div>
          </Card>
        </div>
        <div style={{ marginTop: 22, ...pop(115) }}>
          <Card style={{ padding: "18px 26px" }}>
            <div style={{ fontFamily: SANS, fontSize: 23, fontWeight: 700, color: T.ink[900], marginBottom: 12 }}>herdr 里的 agent</div>
            {[["agent-1", "在干活", T.blue[500]], ["agent-2", "等你", T.pink[300]]].map(([n, st, c]) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: SANS, fontSize: 21, color: T.ink[600], marginBottom: 8 }}>
                <span style={{ width: 14, height: 14, borderRadius: 7, background: c }} />{n}
                <span style={{ marginLeft: "auto", color: T.ink[900] }}>{st}</span>
              </div>
            ))}
          </Card>
        </div>
      </div>
      <Caption dark>mola web：所有 run 一屏看完，危险动作等你点头</Caption>
    </AbsoluteFill>
  );
};

// 3. DSH terminal: footer status line + web embed line
const Tui = () => {
  const f = useCurrentFrame();
  const on = ramp(f, 30, 45);
  const emb = ramp(f, 62, 78);
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.tui), justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1120, height: 440, borderRadius: 20, background: T.night[800], border: `1px solid ${LINE}`, boxShadow: "0 20px 50px rgba(0,0,0,.45)", overflow: "hidden" }}>
        <div style={{ height: 44, background: T.night[700], display: "flex", alignItems: "center", gap: 10, paddingLeft: 20 }}>
          {[T.pink[300], T.blue[300], T.blue[500]].map((c) => <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
          <span style={{ fontFamily: MONO, fontSize: 18, color: DIM, marginLeft: 12 }}>dsh · tui-demo</span>
        </div>
        <div style={{ padding: "26px 34px", fontFamily: MONO, fontSize: 24, color: FG, lineHeight: 1.7 }}>
          <div><span style={{ color: T.blue[300] }}>Read</span> .mstack/PLAN.md <span style={{ color: DIM }}>· 0s</span></div>
          <div><span style={{ color: T.blue[300] }}>Pwsh</span>(npm test) <span style={{ color: DIM }}>· 6s</span></div>
          <div style={{ color: DIM }}>● 换条路 · 20s · 工具x14</div>
          <div style={{ marginTop: 24, border: `1px solid ${LINE}`, borderRadius: 12, padding: "8px 16px", color: DIM }}>❯ <span style={{ opacity: f % 30 < 15 ? 1 : 0 }}>▍</span></div>
          <div style={{ marginTop: 18, fontSize: 22, color: DIM, whiteSpace: "nowrap" }}>
            group/group-3 · ● 1 · high · 缓存 90.7% ·{" "}
            <span style={{
              color: T.pink[500], padding: "2px 8px", borderRadius: 8,
              background: `rgba(221,102,141,${0.22 * on})`, outline: `2px solid rgba(221,102,141,${on})`,
            }}>mstack ✗L1/L3 等你1 跑1</span>
          </div>
          <div style={{ marginTop: 14, fontSize: 21, color: T.pink[300], opacity: emb, transform: `translateY(${(1 - emb) * 10}px)`, whiteSpace: "nowrap" }}>
            verify ✗ L1 / L3 · 缺口 3 · 等你 1 · 在跑 1 · herdr 等你 1
          </div>
        </div>
      </div>
      <Caption>终端状态栏同样盯着：验证缺口、等你的、在跑的</Caption>
    </AbsoluteFill>
  );
};

// 4. m-cua beat
const CUA_STEPS: [number, string, string][] = [
  [8, "mola-cua snapshot", "→ @e1 窗口  @e2 文本框  @e3 按钮「保存」"],
  [38, "mola-cua click @e3", "→ ok"],
  [66, "mola-cua get text @e2", "→ 已保存  (期望: 已保存)"],
];

const Cua = () => {
  const f = useCurrentFrame();
  const rec = ramp(f, 90, 102);
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.cua), justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1000, background: T.night[800], border: `1px solid ${LINE}`, borderRadius: 20, padding: "34px 44px", fontFamily: MONO, fontSize: 28, boxShadow: "0 20px 50px rgba(0,0,0,.45)" }}>
        {CUA_STEPS.map(([at, cmd, out]) => (
          <div key={cmd} style={{ opacity: ramp(f, at, at + 10), marginBottom: 20 }}>
            <div style={{ color: FG }}><span style={{ color: T.pink[300] }}>$ </span>{cmd}</div>
            <div style={{ color: DIM, fontSize: 24, marginTop: 4 }}>{out}</div>
          </div>
        ))}
        <div style={{
          marginTop: 28, display: "inline-block", opacity: rec, transform: `scale(${0.92 + 0.08 * rec})`,
          padding: "12px 26px", borderRadius: 999, background: "rgba(74,222,128,.14)", border: "2px solid #4ade80", color: "#4ade80", fontSize: 30,
        }}>L4 ✓ receipt</div>
      </div>
      <Caption>m-cua：真去点一下桌面应用，拿到 L4 回执</Caption>
    </AbsoluteFill>
  );
};

const End = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.end), justifyContent: "center", alignItems: "center", gap: 30 }}>
      {["npm i -g @molamaker/mstack", 'mola go "给首页英雄区加上滚动视差"'].map((l, i) => (
        <div key={l} style={{
          opacity: ramp(f, 8 + i * 14, 20 + i * 14), fontFamily: MONO, fontSize: i ? 34 : 38, color: FG,
          background: T.night[800], border: `1px solid ${LINE}`, borderRadius: 16, padding: "18px 36px",
        }}>
          <span style={{ color: T.pink[300] }}>$ </span>{l}
        </div>
      ))}
      <div style={{ fontFamily: MONO, fontSize: 24, color: T.blue[300], opacity: ramp(f, 46, 58) }}>github.com/Mola-maker/mstack</div>
    </AbsoluteFill>
  );
};

export const Demo = () => {
  let at = 0;
  const seq = (len: number, el: React.ReactNode) => {
    const from = at;
    at += len;
    return <Sequence from={from} durationInFrames={len}>{el}</Sequence>;
  };
  return (
    <AbsoluteFill style={{ background: BG }}>
      {seq(SCENES.title, <Title />)}
      {seq(SCENES.route, <Route />)}
      {seq(SCENES.web, <Web />)}
      {seq(SCENES.tui, <Tui />)}
      {seq(SCENES.cua, <Cua />)}
      {seq(SCENES.end, <End />)}
    </AbsoluteFill>
  );
};
