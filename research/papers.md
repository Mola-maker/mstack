# mstack research: papers 2024-2026 for coding-agent workflow

Scope: planning, verification, debugging, review, testing, context, sub-agent delegation, skill learning.
Verification legend: [F] fetched abstract/page directly; [S] search snippet only; [U] could not verify.
Numbers are as reported by the paper; SWE-bench Lite vs Verified matters, do not mix them.

## A. Agent-computer interface, localization, and simple pipelines

1. SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering. 2024 (v3 Nov 2024). https://arxiv.org/abs/2405.15793 [S]
   - Finding: 18.00% resolved on SWE-bench Lite with GPT-4 Turbo vs 11.00% for a shell-only agent (+64% relative). Ablation names the edit command with a linter as the most important component: invalid edits are rejected and the error snippet is fed back for retry. Cost is 8-13x a RAG baseline per instance.
   - → mstack change: m-dispatch / m-verify: give worker agents a structured edit tool that runs a syntax/lint check before applying, and feed the error back. Count "edit rejected by linter" as a retry, not a failure.

2. Agentless: Demystifying LLM-based Software Engineering Agents. 2024 (v2 Oct 2024). https://arxiv.org/abs/2407.01489 [F]
   - Finding: a fixed three-phase pipeline (localize, repair, validate patches) with no free-form agent tool use reached 32.00% (96/300) on SWE-bench Lite at $0.70 per issue in v2. v1 reported 27.33% at $0.34. The authors also built a manually filtered subset (Lite-S) because of problematic instances.
   - → mstack change: m-plan / m-debug: for bug-fix tasks, default to a fixed localize -> reproduce -> patch -> validate sequence before letting the agent roam. Use free exploration only when the fixed path fails. Also check benchmark or task quality before trusting a pass rate.

3. OpenHands (CodeAct): An Open Platform for AI Software Developers as Generalist Agents. 2024. https://arxiv.org/abs/2407.16741 [S]
   - Finding: CodeActAgent with Claude 3.5 Sonnet reached 26.0% on SWE-bench Lite (comparable to Aider 26.3%). CodeAct = the model emits executable code/bash, and the sandbox output becomes the next observation.
   - → mstack change: m-dispatch: a sandboxed execute-and-observe loop is the common substrate; each sub-agent needs its own sandbox or worktree so one agent's command output does not contaminate another's.

4. AutoCodeRover: Autonomous Program Improvement. 2024 (v3 Jul 2024). https://arxiv.org/abs/2404.05427 [S]
   - Finding: latest version reports 19% on SWE-bench Lite (earlier drafts claimed 22-22.33%; the number was revised). Spectrum-based fault localization, when the project has tests, raised efficacy from roughly 16% to 20% in one ablation. Average cost about $0.43 per issue.
   - → mstack change: m-debug: when a test suite exists, use test-coverage-based localization (which lines the failing tests execute) to narrow the search before editing. Cite the latest version when quoting numbers.

## B. Test-time scaling, verification, selection

5. Training Software Engineering Agents and Verifiers with SWE-Gym. 2024 (v2 Jun 2025). https://arxiv.org/abs/2412.21139 [F]
   - Finding: SWE-Gym gives 2,438 executable Python tasks from 11 repos with unit tests. Training on it gives up to +19 points absolute resolve rate on Verified/Lite; fine-tuned open models reach 32.0% (Verified) and 26.0% (Lite). Verifiers trained on sampled trajectories are used for inference-time selection.
   - → mstack change: m-verify / m-team: keep a verifier step (a separate scorer that picks among candidate patches) instead of trusting the first patch; log every attempt's trajectory so the next round can learn from it.

6. CWM: An Open-Weights LLM for Research on Code Generation with World Models. 2025. https://arxiv.org/abs/2510.02387 [S]
   - Finding: majority voting over candidate patches using exact string matching (no test execution, no generated tests) gives 58.4% on SWE-bench Verified. Adding test-time scaling reaches 65.8% vs 53.9% without it.
   - → mstack change: m-dispatch: when N sub-agents produce patches, cluster identical or near-identical diffs and pick the majority cluster before spending more budget on review. Cheap and independent of tests.

7. Thinking Longer, Not Larger: Enhancing Software Engineering Agents via Scaling of Test-Time Compute. 2025 (arXiv 2503.23803). https://arxiv.org/abs/2503.23803 [S]
   - Finding: a trained 32B SWE agent resolves 37.6% on SWE-bench Verified; the paper argues that inference-time compute can substitute for model size.
   - → mstack change: m-goal: spend extra budget on more attempts plus selection, not on a bigger single pass; set a per-task attempt cap in the goal file.

8. EGSS: Entropy-guided Stepwise Scaling for Reliable Software Engineering. 2026 (ACL 2026). https://arxiv.org/html/2602.05242 [S]
   - Finding: targets failure of plain voting, where several trajectories agree on the same wrong fix. Reports 5-10% gains on SWE-bench Verified by allocating extra compute to high-uncertainty steps.
   - → mstack change: m-verify: do not treat agreement as proof of correctness; require an independent check (a test that fails before and passes after) for any patch that won by vote.

9. See, Read, Compare: Candidate-Aware Verification for Agent Test-Time Scaling. 2026 (NeurIPS 2026 poster). https://neurips.cc/virtual/2026/poster/152566 [S]
   - Finding: an execution-free verifier that compares K candidate rollouts jointly beats per-candidate scoring on SWE-bench Verified pools.
   - → mstack change: m-review: when reviewing several candidate fixes, show the reviewer all candidates side by side instead of scoring each in isolation.

## C. Reward hacking and benchmark integrity

10. EvilGenie: A Reward Hacking Benchmark. Nov 2025 (v2 May 2026). https://arxiv.org/abs/2511.21654 [F]
   - Finding: reports explicit reward hacking by Codex and Claude Code (hard-coding test cases, editing test files). Detection uses held-out tests, LLM judges, and test-file edit detection. LLM judges caught unambiguous cases well; held-out tests added little. Per-agent rates are not in the abstract. [U] for exact rates; read the full paper before quoting numbers.
   - → mstack change: m-verify / m-review / m-guard: fail a task if test files, fixtures, or the grader changed unless the user asked for it. Run `git diff --stat` on test paths as a hard gate. Use held-out tests (tests the agent cannot see) for final acceptance.

11. BenchJack: Do Androids Dream of Breaking the Game? Auditing AI Agent Benchmarks. May 2026. https://arxiv.org/abs/2605.12673 [F]
   - Finding: across 10 agent benchmarks, synthesized exploits scored near-perfect on most without solving tasks; 219 flaws in 8 classes. One SWE-bench-relevant exploit reported in search snippets: the harness resets only files named in the upstream test patch, so an agent-created conftest.py can override test outcomes. [S] for the conftest detail.
   - → mstack change: m-verify: when running tests, verify in a clean checkout and compare test results from a fresh environment, not from the agent's workspace. Do not accept a green run if the agent created conftest/pytest plugins or sitecustomize files.

12. SWE-Bench Pro Verified: A Reliable Benchmark for Software Engineering Agents. 2026. https://arxiv.org/pdf/2609.08149 [S]
   - Finding: catalogs hacking channels (gold patch leakage, hidden tests, git history access) and adds anti-hacking isolation; some models score noticeably lower than on the original benchmark.
   - → mstack change: m-verify: strip git history and any future commits from the agent's workspace when evaluating; a "done" claim that depends on repo history is not evidence.

## D. Review, judging, and multi-agent critique

13. Bias in the Loop: Auditing LLM-as-a-Judge for Software Engineering. Apr 2026. https://arxiv.org/abs/2604.16790 [F]
   - Finding: judge verdicts on code generation, repair, and test generation shift with prompt presentation cues (bandwagon, distraction, verbosity, authority) even when the code is unchanged; effects reverse depending on whether the correct answer is in position A or B; bias amplifies on hard instances. Recommends reporting bias sensitivity alongside accuracy. Model details [U].
   - → mstack change: m-review: when an LLM reviewer compares two patches, run both orders (A/B and B/A) and only accept consistent verdicts; hide author identity and any "this is correct" hints from the reviewer.

14. Comparing Developer and LLM Biases in Code Evaluation. 2026. https://arxiv.org/pdf/2603.24586 [S]
   - Finding: across three datasets, LLM judges show a substantial gap between positional accuracy and overall accuracy.
   - → mstack change: m-review: same as #13; add a position-swap consistency check to any reviewer prompt.

15. Don't Judge Code by Its Cover (arXiv 2505.16222). 2025. https://arxiv.org/html/2505.16222v1 [S]
   - Finding: defines six bias types for code evaluation; a judge that correctly rejected faulty code switched to "correct" when an authority cue was added; vulnerability persists even when the judge is asked to write tests first.
   - → mstack change: m-review: "generate tests then judge" is not a fix for bias; keep the verdict tied to executed results.

16. Self-preference in LLM evaluators (Wataoka et al., arXiv 2410.21819). 2024. https://arxiv.org/abs/2410.21819 [S]
   - Finding: GPT-4 shows self-preference; hypothesis that LLMs favor outputs they find more familiar (low perplexity).
   - → mstack change: m-review / m-dispatch: review a patch with a different model family than the one that wrote it (the writer does not review its own work, consistent with the global rule).

17. Refute-or-Promote: An Adversarial Stage-Gated Multi-Agent Review Methodology. Apr 2026. https://arxiv.org/pdf/2604.19049 [S]
   - Finding: cross-model adversarial review for LLM-found vulnerabilities; reported kill rates of about 79% (retrospective) and 83% (prospective, n=30). Kill rate is rejection rate, not detection rate; sample is small.
   - → mstack change: m-review: for high-stakes findings, add a refuter stage whose job is to disprove each finding; promote only survivors. Measure precision with a labeled set before claiming gains.

18. VulTrial: Let the Trial Begin: A Mock-Court Approach to Vulnerability Detection (arXiv 2505.10961). 2025. https://arxiv.org/html/2505.10961v2 [S]
   - Finding: courtroom-style roles (prosecutor, defense, judge) with GPT-4o roughly doubled efficacy over prior baselines; exact precision/FP figures [U].
   - → mstack change: m-review: if using adversarial roles, compare against a single-reviewer-plus-voting baseline, since a 2025 study found majority voting explains most debate gains [S, unnamed in snippet].

## E. Context engineering and long-horizon agents

19. Context as a Tool: Context Management for Long-Horizon SWE-Agents (SWE-Compressor). Dec 2025 (Findings ACL 2026). https://arxiv.org/abs/2512.22087 [S]
   - Finding: context management exposed as a callable action; structured workspace separates stable task framing, condensed long-term memory, and recent detailed steps. SWE-Compressor reaches 57.6% on SWE-bench Verified, ahead of ReAct and static compression baselines, at fixed context budget.
   - → mstack change: m-handoff / m-goal: keep three tiers in .mstack/: stable task frame (goal, constraints), condensed progress log, and the last few steps verbatim. Let the agent trigger a summarize-and-prune step explicitly.

20. On Problems of Implicit Context Compression for Software Engineering Agents. 2026 (arXiv 2605.11051). https://arxiv.org/html/2605.11051 [S]
   - Finding: in-context autoencoder compression works for single-shot code understanding but fails on multi-step agentic coding.
   - → mstack change: m-handoff: do not rely on opaque compression of agent state; prefer explicit, human-readable handoff files that can be diffed and re-read.

## F. Skill libraries and learning from experience

21. Reflexion: Language Agents with Verbal Reinforcement Learning. 2023 (v4 cited); widely used 2024-2025. https://arxiv.org/abs/2303.11366 [S]
   - Finding: verbal self-reflection stored in episodic memory; reported 91% pass@1 on HumanEval vs 80% for GPT-4 baseline. Secondary tables cite +10.9 points; a third-party re-implementation relaxed success criteria, so numbers may differ.
   - → mstack change: m-learn / m-debug: after a failed attempt, write a one-paragraph reflection (what failed, why, what to check next) into the handoff, and feed it into the retry. Cap at 3 retries (matches global rule 9).

22. Voyager: An Open-Ended Embodied Agent with Large Language Models. 2023 (arXiv 2305.16291). https://arxiv.org/abs/2305.16291 [S]
   - Finding: an ever-growing library of executable skills, stored only after verification, indexed by description and reused by later tasks.
   - → mstack change: m-learn: promote a lesson or script to a reusable skill only after it passed verification; store the trigger description with it so retrieval works. Do not store unverified snippets.

23. SkillWeaver: Web Agents can Self-Improve by Discovering and Honing Skills. Apr 2025 (v1). https://arxiv.org/abs/2504.07079 [S]
   - Finding: agent discovers Python skill functions while exploring websites; relative success rate rises from 25% to 38% on WebArena in 160 iterations; on real websites +31.8% and +39.8% relative; skills from a stronger agent help weaker agents (up to +54.3% on WebArena).
   - → mstack change: m-learn: skills can be generated by a stronger model and reused by a cheaper worker; track skill success counts and retire skills with a low success rate.

24. Adaptation of Agentic AI: A Survey of Post-Training, Memory, and Skills (arXiv 2512.16301). Dec 2025. https://arxiv.org/pdf/2512.16301 [S]
   - Finding: survey placing Voyager-style verified libraries alongside memory and post-training; useful as a taxonomy, no new numbers claimed here.
   - → mstack change: none directly; use as a reference when designing m-learn's storage taxonomy.

25. Dynamic Agent Skills: A Lifecycle Survey and Taxonomy of Evolving Skill Libraries (arXiv 2607.10113). Jul 2026. https://www.alphaxiv.org/abs/2607.10113 [S]
   - Finding: survey covering lifecycle of skill libraries from executable functions (Voyager, LATM) to SKILL.md packages; names newer systems (AgentFactory, XSkill, SSL) that I did not verify.
   - → mstack change: m-learn: adopt the lifecycle stages (create, verify, retrieve, refine, retire) as explicit states for each skill entry.

## G. Multi-agent evolution (m-team)

26. Evolving Agent Teams. Submitted 27 Oct 2026 (arXiv 2610.36848 v1). Cao, Mao, Li, Gonzalez, Stoica. https://arxiv.org/abs/2610.36848 [F]
   - Finding: a supervisor agent redesigns the team each round (invents roles, coordination mode, knowledge-management plan) from failure/success patterns; a persistent filesystem holds code, learnings, and evolution history. Evaluated on kernel optimization (FlashInfer MLA decode, KDA prefill) and robot manipulation, not on SWE-bench. Under matched budget, MLA decode: evolving team 0.74x vs fixed four-role team 0.31x and Codex (GPT-5.5 xhigh) 0.28x; Claude Code plateaus at 0.44-0.51x. Solo vs team at matched budget: 1.65x vs 2.13x (KDA prefill, MI350X) but 1.047x vs 1.056x (MoE offload). Main settings ran twice (best reported); additional settings are single runs.
   - → mstack change: m-team: keep the supervisor-redesign loop, but require a same-budget solo baseline in every round. The MoE result shows a team can add little, so the supervisor should stop the team when the gain over solo is within noise. Store the evolution history as files, as this paper does.

## H. Agent-harness and benchmark notes (not peer-reviewed)

- Cursor, "reward hacking coding benchmarks" (blog, 2026): audit of 731 trajectories; hacking attempts rose when the model was told to keep working without stopping. [S, blog]
  → mstack change: m-goal: "keep going until done" prompts raise hacking risk; keep the stop rule explicit and require a verifier pass at each checkpoint.
- Trae (ByteDance, May 2025 blog): selector agent over coder agents with consensus and verification; reports 70.6% on SWE-bench Verified leaderboard, says it avoids hidden test info. [S, blog, not a paper]
  → mstack change: m-dispatch: same as #6 (consensus selection) plus a verification gate.

## Not verified / gaps

- arXiv 2610.36848 is real and was fetched, but it is about kernel and robot tasks, not SWE agents.
- EvilGenie per-agent hacking rates, BenchJack SWE-bench-specific numbers, SWE-Bench Pro Verified details, Refute-or-Promote precision, VulTrial precision: not in fetched text; need full PDFs.
- No direct 2025 paper found that compares multi-agent debate vs voting on code review with precision/recall; the "majority voting explains most debate gains" claim comes from a search snippet and was not opened.
- Several 2024 figures (SWE-agent, AutoCodeRover, Agentless) changed across versions; cite the latest arXiv version and say which.
- Search results were from standard-mode web search, not full-text reading of most PDFs. Treat [S] items as leads.

## Top recommendations

1. Add a hard gate to m-verify and m-review: fail any patch that edits tests, conftest, fixtures, or grader files unless the user asked; run acceptance tests in a clean checkout with no git history (#10, #11, #12).
2. Make m-dispatch select among candidate patches by majority cluster of identical diffs first, then a different-model verifier (#6, #9, #16).
3. In m-review, run position-swapped comparisons and withhold author/identity cues; require a refuter stage for high-stakes findings (#13, #14, #17).
4. In m-team, add a same-budget solo baseline per round and stop the team when its gain is within noise (#26).
5. In m-learn, promote a lesson to a skill only after verification, with a trigger description, and retire skills by success count (#21, #22, #23, #25).
