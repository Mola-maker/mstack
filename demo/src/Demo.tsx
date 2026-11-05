import React from "react";
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const BG = "#0d1117";
const FG = "#e6edf3";
const DIM = "#7d8590";
const ACCENT = "#58a6ff";
const MONO = "'Cascadia Code', 'JetBrains Mono', Consolas, monospace";
const SANS = "'Inter', 'Segoe UI', 'Microsoft YaHei', sans-serif";

const SCENES = { title: 90, merge: 150, skills: 150, route: 160, team: 140, built: 110 };
export const DURATION = Object.values(SCENES).reduce((a, b) => a + b, 0);

// Fade in at the start of a scene and out at its end.
const useFade = (len: number) => {
  const f = useCurrentFrame();
  return interpolate(f, [0, 12, len - 12, len], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
};

const Caption: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", bottom: 56, width: "100%", textAlign: "center", color: DIM, fontFamily: SANS, fontSize: 24 }}>
    {children}
  </div>
);

const Chip: React.FC<{ label: string; on?: boolean; style?: React.CSSProperties }> = ({ label, on, style }) => (
  <div
    style={{
      fontFamily: MONO, fontSize: 22, padding: "10px 18px", borderRadius: 8,
      border: `1px solid ${on ? ACCENT : "#30363d"}`, color: on ? ACCENT : FG,
      background: on ? "rgba(88,166,255,0.08)" : "#161b22", whiteSpace: "nowrap", ...style,
    }}
  >
    {label}
  </div>
);

const Title = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: useFade(SCENES.title) }}>
      <div style={{ fontFamily: MONO, fontSize: 120, color: FG, transform: `translateY(${(1 - s) * 20}px)` }}>mstack</div>
      <div style={{ fontFamily: SANS, fontSize: 30, color: DIM, marginTop: 12, opacity: s }}>
        one de-duplicated skill stack for coding agents
      </div>
    </AbsoluteFill>
  );
};

const SOURCES = [
  { name: "superpowers", n: 15 },
  { name: "gstack", n: 23 },
  { name: "pstack", n: 30 },
  { name: "oh-my-claudecode", n: 18 },
];

const Merge = () => {
  const f = useCurrentFrame();
  const t = interpolate(f, [30, 95], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ease = 1 - Math.pow(1 - t, 3);
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.merge) }}>
      {SOURCES.map((src, i) => {
        const y0 = 170 + i * 90;
        const fade = interpolate(t, [0.45, 0.9], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={src.name} style={{ position: "absolute", left: 140 + ease * 160, top: y0, opacity: fade }}>
            <Chip label={`${src.name} · ${src.n}`} />
          </div>
        );
      })}
      <div style={{ position: "absolute", left: 760, top: 290, opacity: ease }}>
        <Chip on label="16 m-skills" style={{ fontSize: 34, padding: "18px 28px" }} />
      </div>
      <Caption>86 source skills from 4 stacks → merged, de-duplicated, rewritten</Caption>
    </AbsoluteFill>
  );
};

const SKILLS = ["m-start", "m-think", "m-plan", "m-goal", "m-team", "m-dispatch", "m-verify", "m-debug",
  "m-review", "m-ship", "m-qa", "m-research", "m-handoff", "m-learn", "m-deslop", "m-guard"];

const Skills = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.skills) }}>
      <div style={{ position: "absolute", top: 150, left: 140, right: 140, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 22 }}>
        {SKILLS.map((s, i) => {
          const o = interpolate(f, [8 + i * 4, 20 + i * 4], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return <div key={s} style={{ opacity: o }}><Chip label={s} on={s === "m-start"} style={{ textAlign: "center" }} /></div>;
        })}
      </div>
      <Caption>each SKILL.md ≤ 150 lines · one job per skill · Claude Code, DSH and Codex</Caption>
    </AbsoluteFill>
  );
};

const STAGES = ["m-start", "m-think", "m-plan", "m-goal", "m-dispatch", "m-verify", "m-ship"];

const Route = () => {
  const f = useCurrentFrame();
  const typed = "继续".slice(0, Math.floor(interpolate(f, [5, 25], [0, 2], { extrapolateRight: "clamp" })));
  const active = Math.floor(interpolate(f, [40, 140], [0, STAGES.length - 0.01], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.route) }}>
      <div style={{ position: "absolute", top: 150, left: 140, fontFamily: MONO, fontSize: 30, color: FG }}>
        <span style={{ color: DIM }}>&gt; </span>{typed}<span style={{ opacity: f % 30 < 15 ? 1 : 0 }}>▍</span>
      </div>
      <div style={{ position: "absolute", top: 310, left: 70, right: 70, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        {STAGES.map((s, i) => (
          <React.Fragment key={s}>
            <Chip label={s} on={f >= 40 && i === active} style={{ fontSize: 19, padding: "8px 12px", opacity: f >= 40 && i <= active ? 1 : 0.45 }} />
            {i < STAGES.length - 1 && <span style={{ color: DIM, fontFamily: MONO, fontSize: 20 }}>→</span>}
          </React.Fragment>
        ))}
      </div>
      <Caption>a two-character prompt is enough: m-start reads .mstack/ state and resumes the right stage</Caption>
    </AbsoluteFill>
  );
};

const LOOP = ["round v{n}", "measure + gates", "supervisor reflects", "redesign roles"];

const Team = () => {
  const f = useCurrentFrame();
  const angle = interpolate(f, [10, 130], [0, Math.PI * 2]);
  const cx = 640, cy = 330, r = 165;
  const round = 1 + Math.floor(interpolate(f, [10, 130], [0, 3], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.team) }}>
      <svg width={1280} height={720} style={{ position: "absolute" }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#30363d" strokeWidth={2} />
        <circle cx={cx + r * Math.cos(angle - Math.PI / 2)} cy={cy + r * Math.sin(angle - Math.PI / 2)} r={7} fill={ACCENT} />
      </svg>
      {LOOP.map((label, i) => {
        const a = (i / LOOP.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <div key={label} style={{ position: "absolute", left: cx + (r + 8) * Math.cos(a), top: cy + (r + 8) * Math.sin(a), transform: "translate(-50%,-50%)" }}>
            <Chip label={label.replace("{n}", String(round))} style={{ fontSize: 18, padding: "6px 12px" }} />
          </div>
        );
      })}
      <div style={{ position: "absolute", left: cx, top: cy, transform: "translate(-50%,-50%)", fontFamily: MONO, fontSize: 18, color: DIM, textAlign: "center", lineHeight: 1.6 }}>
        LEARNINGS.md<br />SYNTHESIS.md<br />history.md
      </div>
      <Caption>m-team: the team itself evolves each round (after arXiv 2610.36848)</Caption>
    </AbsoluteFill>
  );
};

const Built = () => {
  const f = useCurrentFrame();
  const lines = [
    "framework  → FRAMEWORK.md (Claude)",
    "build      → DSH headless workers via magpie routes",
    "review     → independent DSH reviewer, findings fixed",
    "check      → scripts/check.mjs + CI",
  ];
  return (
    <AbsoluteFill style={{ opacity: useFade(SCENES.built), justifyContent: "center", paddingLeft: 180 }}>
      {lines.map((l, i) => (
        <div key={l} style={{ fontFamily: MONO, fontSize: 26, color: FG, marginBottom: 18, opacity: interpolate(f, [6 + i * 10, 16 + i * 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
          {l}
        </div>
      ))}
      <div style={{ fontFamily: MONO, fontSize: 24, color: ACCENT, marginTop: 36, opacity: interpolate(f, [50, 62], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        github.com/Mola-maker/mstack
      </div>
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
      {seq(SCENES.merge, <Merge />)}
      {seq(SCENES.skills, <Skills />)}
      {seq(SCENES.route, <Route />)}
      {seq(SCENES.team, <Team />)}
      {seq(SCENES.built, <Built />)}
    </AbsoluteFill>
  );
};
