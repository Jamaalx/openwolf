/**
 * Global router: one OpenWolf that follows you across projects.
 *
 * The problem it solves. Hook registration is per project: `openwolf init`
 * writes absolute paths into <project>/.claude/settings.json, and Claude Code
 * only loads that file when the session starts inside that project. Start the
 * agent in your home directory — where a lot of people live, because they work
 * across a dozen checkouts in one session — and OpenWolf is inert no matter how
 * many projects were initialized. Worse, every new clone needs a manual init
 * before it gets any memory at all.
 *
 * This router is registered ONCE at the user level (~/.claude/settings.json),
 * so it fires in every session regardless of cwd. On each hook call it works
 * out which project the agent is actually touching — from the file path, the
 * edit target, the paths inside a Bash command — and forwards the hook to that
 * project's own .wolf/hooks/. Touch a file in another project and the next hook
 * lands there instead. Touch a git repo that has no .wolf yet and it gets
 * initialized in the background, so a fresh clone is covered without anyone
 * remembering to run anything.
 *
 * Design constraints, in priority order:
 *
 *   1. Never break a session. Every failure path exits 0 with no output. A
 *      context tool that can wedge your agent is worse than no context tool.
 *   2. Never execute anything we did not write. A cloned repository can ship
 *      its own .claude/settings.json; this router reads those files to find
 *      hook commands, so it accepts only commands of the exact shape
 *      `node "<project>/.wolf/hooks/<name>.js"` and rejects everything else.
 *      See acceptHookCommand().
 *   3. Never double-fire. Hook entries MERGE across settings levels, so a
 *      session started inside an initialized project already runs that
 *      project's hooks; the router must stand down. See shouldStandDown().
 *   4. Keep concurrent agents apart. Session state is keyed by session_id plus
 *      agent_id, so four subagents each track their own current project and
 *      never write to the same state file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HookPayload {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  [key: string]: unknown;
}

interface SessionState {
  /** cwd the session started in — decides whether project hooks already run. */
  origin?: string;
  /** Project the last resolved hook belonged to. */
  project?: string;
  /** Projects this session has already sent SessionStart to. */
  started?: string[];
  first_seen?: string;
  last_seen?: string;
}

interface GlobalConfig {
  enabled: boolean;
  auto_init: boolean;
  /** Only paths under one of these roots are ever routed or initialized. */
  roots: string[];
  /** Substring matches that disqualify a path outright. */
  deny: string[];
  agents: string[];
  /**
   * Absolute path to the openwolf CLI entry point, recorded by
   * `openwolf global install`. Resolving it at install time rather than from
   * the router's own location keeps auto-init working when the router is
   * installed outside the package tree, and when PATH differs between the
   * user's shell and the hook process.
   */
  cli_path: string;
}

// ─── Paths and config ────────────────────────────────────────────────────────

const HOME = os.homedir();
const OW_DIR = path.join(HOME, ".openwolf");
const CONFIG_PATH = path.join(OW_DIR, "global.json");
const SESSION_DIR = path.join(OW_DIR, "router-sessions");
const INIT_STATE_PATH = path.join(OW_DIR, "router-autoinit.json");
const LOG_PATH = path.join(OW_DIR, "router.log");

const DEFAULT_CONFIG: GlobalConfig = {
  enabled: true,
  auto_init: true,
  roots: [HOME],
  deny: [
    "/node_modules/",
    "/.git/",
    "/dist/",
    "/build/",
    "/.next/",
    "/vendor/",
    "/.venv/",
    "/venv/",
    "/site-packages/",
    "/backups/",
    "/uploads/",
    "/.cache/",
    "/tmp/",
  ],
  agents: ["claude"],
  cli_path: "",
};

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* state is a convenience, never a correctness requirement */
  }
}

function loadConfig(): GlobalConfig {
  const raw = readJSON<Partial<GlobalConfig>>(CONFIG_PATH, {});
  return {
    enabled: raw.enabled ?? DEFAULT_CONFIG.enabled,
    auto_init: raw.auto_init ?? DEFAULT_CONFIG.auto_init,
    roots: Array.isArray(raw.roots) && raw.roots.length ? raw.roots : DEFAULT_CONFIG.roots,
    deny: Array.isArray(raw.deny) ? raw.deny : DEFAULT_CONFIG.deny,
    agents: Array.isArray(raw.agents) && raw.agents.length ? raw.agents : DEFAULT_CONFIG.agents,
    cli_path: typeof raw.cli_path === "string" ? raw.cli_path : DEFAULT_CONFIG.cli_path,
  };
}

/** Router-level diagnostics. Bounded: an invisible tool must not eat a disk. */
function log(line: string): void {
  try {
    if (!process.env.OPENWOLF_ROUTER_DEBUG) return;
    fs.mkdirSync(OW_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_PATH).size > 2_000_000) fs.rmSync(LOG_PATH);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch {
    /* diagnostics never matter enough to fail a hook */
  }
}

// ─── Path containment ────────────────────────────────────────────────────────

function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

/**
 * True when `child` is `parent` or lives inside it.
 *
 * Deliberately not startsWith(): "/root/project-private" has "/root/project"
 * as a string prefix, and treating that as containment routes a sibling
 * checkout's files into the wrong project's memory. OpenWolf hit exactly this
 * bug at the hook level (issue #80); the router must not reintroduce it.
 */
function contains(parent: string, child: string): boolean {
  const p = norm(parent);
  const c = norm(child);
  return c === p || c.startsWith(p + "/");
}

function withinRoots(cfg: GlobalConfig, dir: string): boolean {
  return cfg.roots.some((r) => contains(r, dir));
}

function denied(cfg: GlobalConfig, p: string): boolean {
  const s = norm(p) + "/";
  return cfg.deny.some((d) => s.includes(d));
}

/** Directory to start walking up from: the path itself, or its parent if a file. */
function startDir(p: string): string {
  const resolved = path.resolve(p);
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* not on disk yet — a Write to a new file is the common case */
  }
  return path.dirname(resolved);
}

/** Nearest ancestor holding an initialized .wolf/hooks/ directory. */
function findWolfRoot(from: string): string | null {
  let dir = startDir(from);
  for (let i = 0; i < 14; i++) {
    if (fs.existsSync(path.join(dir, ".wolf", "hooks"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Nearest ancestor that is a git repository.
 *
 * Auto-init is restricted to git repos on purpose. It is the one marker that
 * reliably means "a project someone deliberately created", where package.json
 * does not: a nested package.json in a monorepo would carve one repository
 * into several unrelated brains, and a stray one in a scratch directory would
 * spawn a .wolf nobody asked for.
 */
function findGitRoot(from: string): string | null {
  let dir = startDir(from);
  for (let i = 0; i < 14; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── Extracting candidate paths from a hook payload ──────────────────────────

/**
 * Absolute-ish paths mentioned in a shell command.
 *
 * This is a heuristic and is meant to be one: it only has to find a token that
 * points into a project, not to parse shell grammar. Anything it gets wrong
 * falls through to the session's sticky project, which is right far more often
 * than it is wrong.
 */
function pathsFromCommand(command: string, cwd: string): string[] {
  const out: string[] = [];

  // `cd /some/where && ...` is the strongest signal a command carries.
  const cd = command.match(/(?:^|[;&|]\s*)cd\s+(['"]?)([^'"\s;&|]+)\1/);
  if (cd?.[2]) out.push(cd[2]);

  const tokens = command.match(/(?:'[^']*'|"[^"]*"|[^\s;&|<>()]+)/g) ?? [];
  for (const raw of tokens) {
    const t = raw.replace(/^['"]|['"]$/g, "");
    if (!t || t.startsWith("-")) continue;
    if (t.startsWith("/")) out.push(t);
    else if (t.startsWith("./") || t.startsWith("../")) out.push(path.resolve(cwd, t));
    else if (t.includes("/") && !t.includes("://")) out.push(path.resolve(cwd, t));
  }
  return out;
}

function candidatePaths(payload: HookPayload): string[] {
  const out: string[] = [];
  const cwd = payload.cwd || process.cwd();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(path.resolve(cwd, v));
  };

  const ti = (payload.tool_input ?? {}) as Record<string, unknown>;
  push(ti.file_path);
  push(ti.notebook_path);
  push(ti.path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) push((e as Record<string, unknown>)?.file_path);
  }
  if (Array.isArray(ti.file_paths)) for (const f of ti.file_paths) push(f);

  const tr = payload.tool_response;
  if (tr && typeof tr === "object") {
    push((tr as Record<string, unknown>).filePath);
    push((tr as Record<string, unknown>).file_path);
  }

  if (typeof ti.command === "string") out.push(...pathsFromCommand(ti.command, cwd));

  return out;
}

// ─── Session state, keyed per agent ──────────────────────────────────────────

/**
 * One state file per (session, agent). Four subagents working in four
 * checkouts get four files and never contend for a lock — the alternative,
 * one shared file, is a read-modify-write race on every tool call.
 */
function sessionStatePath(payload: HookPayload): string {
  const key = `${payload.session_id ?? "nosession"}::${payload.agent_id ?? "main"}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(SESSION_DIR, `${hash}.json`);
}

function readSessionState(file: string): SessionState {
  return readJSON<SessionState>(file, {});
}

/** Drop state files untouched for a week so the directory cannot grow forever. */
function pruneSessions(): void {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(SESSION_DIR)) {
      const f = path.join(SESSION_DIR, name);
      try {
        if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f);
      } catch {
        /* raced with another agent's prune */
      }
    }
  } catch {
    /* directory may not exist yet */
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/** Hook file to run for an event when a project's settings.json is unreadable. */
const FALLBACK_HOOKS: Record<string, Array<{ match: RegExp | null; file: string }>> = {
  SessionStart: [{ match: null, file: "session-start.js" }],
  UserPromptSubmit: [{ match: null, file: "user-prompt-submit.js" }],
  PreToolUse: [
    { match: /^Read$/, file: "pre-read.js" },
    { match: /^(Write|Edit|MultiEdit)$/, file: "pre-write.js" },
    { match: /^Bash$/, file: "pre-bash.js" },
  ],
  PostToolUse: [
    { match: /^Read$/, file: "post-read.js" },
    { match: /^(Write|Edit|MultiEdit)$/, file: "post-write.js" },
    { match: /^Bash$/, file: "post-bash.js" },
  ],
  PostToolBatch: [{ match: null, file: "post-batch.js" }],
  PreCompact: [{ match: null, file: "precompact.js" }],
  Stop: [{ match: null, file: "stop.js" }],
  SessionEnd: [{ match: null, file: "session-end.js" }],
};

/**
 * Accept a hook command only if it is literally one of this project's own
 * OpenWolf hooks.
 *
 * The router reads .claude/settings.json out of directories the agent merely
 * touched, and a cloned repository can put anything in that file. Without this
 * gate, `git clone` plus one Read would be arbitrary code execution on the
 * developer's machine. So: parse out the script path, require it to resolve
 * inside <project>/.wolf/hooks/, and require the invocation to be a bare
 * `node <script>` with no extra arguments, no shell metacharacters.
 */
function acceptHookCommand(project: string, command: unknown): string | null {
  if (typeof command !== "string") return null;
  const m = command.match(/^\s*node\s+"?([^"]+\.js)"?\s*$/);
  if (!m) return null;
  const script = path.resolve(m[1]);
  const hooksDir = path.join(path.resolve(project), ".wolf", "hooks");
  if (!contains(hooksDir, script)) return null;
  if (!fs.existsSync(script)) return null;
  return script;
}

/** Scripts to run for this event, preferring the project's own registration. */
function resolveHookScripts(project: string, event: string, toolName: string): string[] {
  const settings = readJSON<{ hooks?: Record<string, unknown> }>(
    path.join(project, ".claude", "settings.json"),
    {}
  );
  const entries = settings.hooks?.[event];
  const scripts: string[] = [];

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const e = entry as { matcher?: string; hooks?: Array<{ command?: unknown }> };
      const matcher = typeof e.matcher === "string" ? e.matcher : "";
      if (matcher && toolName) {
        let ok = false;
        try {
          ok = new RegExp(`^(?:${matcher})$`).test(toolName);
        } catch {
          ok = matcher === toolName;
        }
        if (!ok) continue;
      } else if (matcher && !toolName) {
        continue;
      }
      for (const h of e.hooks ?? []) {
        const script = acceptHookCommand(project, h?.command);
        if (script && !scripts.includes(script)) scripts.push(script);
      }
    }
  }

  if (scripts.length) return scripts;

  // The project has .wolf/hooks/ but no usable registration (someone wired
  // only Codex, or hand-edited the file). Fall back to the manifest so the
  // memory still works rather than silently doing nothing.
  for (const { match, file } of FALLBACK_HOOKS[event] ?? []) {
    if (match && toolName && !match.test(toolName)) continue;
    if (match && !toolName) continue;
    const script = path.join(project, ".wolf", "hooks", file);
    if (fs.existsSync(script) && !scripts.includes(script)) scripts.push(script);
  }
  return scripts;
}

interface HookOutput {
  context: string[];
  passthrough: Record<string, unknown> | null;
  exitCode: number;
}

/**
 * Run one project's hook scripts with the payload rewritten to that project.
 *
 * Both CLAUDE_PROJECT_DIR and OPENWOLF_PROJECT_ROOT are set because
 * getProjectDir() in shared.ts reads CLAUDE_PROJECT_DIR first: setting only
 * the OpenWolf variable would lose to the harness's own value (the session's
 * start directory) and every hook would write into the wrong project.
 */
function runHooks(
  project: string,
  event: string,
  payload: HookPayload,
  scripts: string[]
): HookOutput {
  const result: HookOutput = { context: [], passthrough: null, exitCode: 0 };
  const input = JSON.stringify({ ...payload, cwd: project, hook_event_name: event });

  for (const script of scripts) {
    let proc;
    try {
      proc = spawnSync(process.execPath, [script], {
        input,
        cwd: project,
        encoding: "utf-8",
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: project,
          OPENWOLF_PROJECT_ROOT: project,
          OPENWOLF_ROUTED: "1",
        },
      });
    } catch (err) {
      log(`spawn failed ${script}: ${String(err)}`);
      continue;
    }

    if (proc.status === 2) {
      // A blocking decision is the one thing that must never be swallowed.
      result.exitCode = 2;
      if (proc.stderr) process.stderr.write(proc.stderr);
    }

    const stdout = (proc.stdout ?? "").trim();
    if (!stdout) continue;
    try {
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
      const ctx = hso?.additionalContext;
      if (typeof ctx === "string" && ctx.trim()) result.context.push(ctx);
      // Anything that is not additionalContext (permissionDecision,
      // continue: false, systemMessage) is a control signal we must not
      // reinterpret — carry the last one through verbatim.
      const rest = { ...parsed };
      delete rest.hookSpecificOutput;
      const hsoRest = { ...(hso ?? {}) };
      delete hsoRest.additionalContext;
      delete hsoRest.hookEventName;
      if (Object.keys(rest).length || Object.keys(hsoRest).length) {
        result.passthrough = { ...(result.passthrough ?? {}), ...rest, ...hsoRest };
      }
    } catch {
      log(`non-JSON stdout from ${script}`);
    }
  }
  return result;
}

// ─── Auto-init ───────────────────────────────────────────────────────────────

/**
 * Initialize a repository that has no .wolf yet, without making anyone wait.
 *
 * `openwolf init` scans the whole tree (500+ files on a mid-size project), far
 * past a hook's timeout, so it is spawned detached and the current hook call
 * returns immediately with no context. The session picks the project up on the
 * next tool call. Each repository is attempted once per day: a repo that fails
 * to initialize must not retry on every keystroke forever.
 */
function maybeAutoInit(cfg: GlobalConfig, project: string): void {
  if (!cfg.auto_init) return;

  if (!cfg.cli_path || !fs.existsSync(cfg.cli_path)) {
    log(`auto-init skipped for ${project}: cli_path unset or missing`);
    return;
  }

  // Throttle only once an attempt is actually going to happen. Recording the
  // timestamp before the preconditions were checked meant a single skipped
  // call — a router installed before the CLI path was known — locked that
  // repository out of auto-init for the next 24 hours.
  const state = readJSON<Record<string, string>>(INIT_STATE_PATH, {});
  const last = state[norm(project)];
  if (last && Date.now() - Date.parse(last) < 24 * 60 * 60 * 1000) return;
  state[norm(project)] = new Date().toISOString();
  writeJSONAtomic(INIT_STATE_PATH, state);

  try {
    const child = spawn(process.execPath, [cfg.cli_path, "init", "--agent", ...cfg.agents], {
      cwd: project,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OPENWOLF_AUTOINIT: "1" },
    });
    child.unref();
    log(`auto-init spawned for ${project}`);
  } catch (err) {
    log(`auto-init failed for ${project}: ${String(err)}`);
  }
}

// ─── Stand-down check ────────────────────────────────────────────────────────

/**
 * True when this session already runs a project's own hooks.
 *
 * Hook entries merge across settings levels, so a session started inside an
 * initialized project has that project's twelve hooks registered alongside the
 * router's. Routing on top of that would run every hook twice — two ledger
 * writes, two injected digests, double the latency.
 *
 * The test uses the session's ORIGIN directory, not the current cwd: Claude
 * Code resolves project settings once at startup, so a session that began in
 * the home directory and later cd'd into a project still has no project hooks
 * loaded, and the router is the only thing that will serve it.
 */
function shouldStandDown(origin: string): boolean {
  return findWolfRoot(origin) !== null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    setTimeout(
      () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf-8") : "{}"),
      4000
    );
  });
}

function emit(event: string, out: HookOutput): void {
  const context = out.context.filter(Boolean).join("\n\n");
  const passthrough = out.passthrough ?? {};
  if (!context && !Object.keys(passthrough).length) return;

  const hookSpecificOutput: Record<string, unknown> = { hookEventName: event, ...passthrough };
  if (context) hookSpecificOutput.additionalContext = context;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--selfcheck")) {
    process.stdout.write("ok router");
    return;
  }

  const cfg = loadConfig();
  if (!cfg.enabled) return;

  // A routed hook must never re-enter the router. Belt and braces: the hooks
  // we spawn are plain scripts, not Claude tool calls, so this cannot happen
  // today — but it costs one comparison to make it impossible tomorrow.
  if (process.env.OPENWOLF_ROUTED) return;

  const payload = JSON.parse((await readStdin()) || "{}") as HookPayload;
  const event = payload.hook_event_name;
  if (!event) return;

  const statePath = sessionStatePath(payload);
  const state = readSessionState(statePath);
  const origin = state.origin ?? payload.cwd ?? process.cwd();

  // Persist the origin on the very first call, before anything can return
  // early. The stand-down test depends on it: a session that started inside a
  // project and later cd'd out would otherwise stop standing down, and every
  // hook would run twice — once from the project's registration, once from
  // here.
  if (!state.origin) {
    state.origin = origin;
    state.first_seen = state.first_seen ?? new Date().toISOString();
    writeJSONAtomic(statePath, state);
  }

  if (shouldStandDown(origin)) {
    log(`stand down: session origin ${origin} has its own hooks`);
    return;
  }

  // Resolve the project this call is about: an initialized project wins over
  // a bare git repo (a monorepo's .wolf sits above its inner package.json),
  // and anything explicit wins over the session's sticky project.
  let target: string | null = null;
  let needsInit: string | null = null;

  for (const candidate of candidatePaths(payload)) {
    if (denied(cfg, candidate)) continue;
    const wolf = findWolfRoot(candidate);
    if (wolf && withinRoots(cfg, wolf)) {
      target = wolf;
      break;
    }
    if (!needsInit) {
      const git = findGitRoot(candidate);
      if (git && withinRoots(cfg, git) && !denied(cfg, git) && norm(git) !== norm(HOME)) {
        needsInit = git;
      }
    }
  }

  if (!target && needsInit) {
    maybeAutoInit(cfg, needsInit);
    return; // nothing to route until the background init lands
  }

  // Events that carry no path at all — SessionStart, Stop, UserPromptSubmit,
  // a bare `npm test` — belong to whatever the session was last working on.
  if (!target && state.project && fs.existsSync(path.join(state.project, ".wolf"))) {
    target = state.project;
  }

  const now = new Date().toISOString();
  if (!target) {
    // Still worth recording the origin, so the stand-down test is stable for
    // the rest of the session even if the agent cd's somewhere else later.
    writeJSONAtomic(statePath, {
      ...state,
      origin,
      first_seen: state.first_seen ?? now,
      last_seen: now,
    });
    return;
  }

  const started = state.started ?? [];
  const switching = state.project && norm(state.project) !== norm(target);
  const output: HookOutput = { context: [], passthrough: null, exitCode: 0 };

  // Leaving a project: let it close its books (ledger flush, action log) the
  // same way a real session end would.
  if (switching && state.project) {
    const stopScripts = resolveHookScripts(state.project, "Stop", "");
    if (stopScripts.length) runHooks(state.project, "Stop", payload, stopScripts);
  }

  // First contact with a project inside this session: give it its SessionStart
  // before the event that woke it, so the digest lands ahead of the work.
  if (!started.includes(norm(target)) && event !== "SessionStart") {
    const startScripts = resolveHookScripts(target, "SessionStart", "");
    if (startScripts.length) {
      const res = runHooks(target, "SessionStart", { ...payload, tool_name: undefined }, startScripts);
      output.context.push(...res.context);
    }
    started.push(norm(target));
  }

  const scripts = resolveHookScripts(target, event, payload.tool_name ?? "");
  if (scripts.length) {
    const res = runHooks(target, event, payload, scripts);
    output.context.push(...res.context);
    if (res.passthrough) output.passthrough = { ...(output.passthrough ?? {}), ...res.passthrough };
    if (res.exitCode === 2) output.exitCode = 2;
  }

  writeJSONAtomic(statePath, {
    origin,
    project: target,
    started,
    first_seen: state.first_seen ?? now,
    last_seen: now,
  });

  if (Math.random() < 0.02) pruneSessions();

  emit(event, output);
  if (output.exitCode === 2) process.exit(2);
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    log(`fatal: ${String(err)}`);
    process.exit(0); // never break the session
  });
