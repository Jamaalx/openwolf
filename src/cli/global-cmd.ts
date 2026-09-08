/**
 * `openwolf global` — install the cross-project router.
 *
 * `openwolf init` wires one project. This wires the machine: a single hook
 * registration in ~/.claude/settings.json that fires in every session and
 * forwards each hook to whichever project the agent is actually touching,
 * initializing new git repositories on first contact.
 *
 * The two are complementary, not alternatives. A session started inside an
 * initialized project keeps using that project's own hooks (the router stands
 * down); the router exists for sessions started anywhere else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { buildRouterHookSettings, ROUTER_EVENTS } from "./hook-manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = os.homedir();
const OW_DIR = path.join(HOME, ".openwolf");
const ROUTER_DIR = path.join(OW_DIR, "router");
const ROUTER_PATH = path.join(ROUTER_DIR, "router.js");
const CONFIG_PATH = path.join(OW_DIR, "global.json");
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");

interface Settings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSONAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Compiled router.js, wherever this build put it. Mirrors copyHookScripts(). */
function findRouterSource(): string | null {
  const candidates = [
    path.join(__dirname, "..", "hooks", "router.js"),
    path.resolve(__dirname, "..", "..", "hooks", "router.js"),
    path.resolve(__dirname, "..", "..", "dist", "hooks", "router.js"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** The installed CLI entry point, recorded so the router can auto-init. */
function findCliPath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "bin", "openwolf.js"),
    path.resolve(__dirname, "..", "..", "..", "dist", "bin", "openwolf.js"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? "";
}

/** True for a hook entry this command owns — matched on the router path. */
function isRouterEntry(entry: unknown): boolean {
  const e = entry as { hooks?: Array<{ command?: unknown }> };
  return (e?.hooks ?? []).some(
    (h) => typeof h?.command === "string" && h.command.includes("/.openwolf/router/router.js")
  );
}

/**
 * Strip every router entry from a settings object, leaving other hooks alone.
 *
 * User settings are shared with everything else the person has wired up, so
 * install and uninstall must be surgical: never rewrite the hooks block
 * wholesale, only remove the entries whose command points at our router.
 */
function stripRouter(settings: Settings): Settings {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isRouterEntry(e));
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

export function globalInstallCommand(opts?: { roots?: string[]; noAutoInit?: boolean }): void {
  const source = findRouterSource();
  if (!source) {
    console.error(chalk.red("Router not found in this install. Run `pnpm build` first."));
    process.exit(1);
  }

  fs.mkdirSync(ROUTER_DIR, { recursive: true });
  fs.copyFileSync(source, ROUTER_PATH);

  // Refuse to register a router that cannot load: a broken global hook fires
  // on every tool call in every session, which is the worst possible blast
  // radius for a silent failure.
  const check = spawnSync(process.execPath, [ROUTER_PATH, "--selfcheck"], {
    encoding: "utf-8",
    timeout: 10000,
  });
  if (!(check.stdout ?? "").includes("ok router")) {
    console.error(chalk.red("Router selfcheck failed — not registering."));
    if (check.stderr) console.error(chalk.dim(check.stderr.trim()));
    process.exit(1);
  }

  const existing = readJSON<Record<string, unknown>>(CONFIG_PATH, {});
  const config = {
    version: 1,
    enabled: true,
    auto_init: opts?.noAutoInit ? false : (existing.auto_init ?? true),
    roots: opts?.roots?.length ? opts.roots.map((r) => path.resolve(r)) : (existing.roots ?? [HOME]),
    deny: existing.deny ?? undefined,
    agents: existing.agents ?? ["claude"],
    cli_path: findCliPath(),
  };
  for (const k of Object.keys(config)) {
    if ((config as Record<string, unknown>)[k] === undefined) {
      delete (config as Record<string, unknown>)[k];
    }
  }
  writeJSONAtomic(CONFIG_PATH, config);

  const settings = stripRouter(readJSON<Settings>(CLAUDE_SETTINGS, {}));
  const block = buildRouterHookSettings(ROUTER_PATH);
  settings.hooks = settings.hooks ?? {};
  for (const [event, entries] of Object.entries(block.hooks)) {
    const current = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...current, ...entries];
  }
  writeJSONAtomic(CLAUDE_SETTINGS, settings);

  const roots = (config.roots as string[]).join(", ");
  console.log();
  console.log(chalk.bold("  OpenWolf global router installed"));
  console.log();
  console.log(`  ${chalk.green("✓")} router     ${chalk.dim(ROUTER_PATH)}`);
  console.log(`  ${chalk.green("✓")} hooks      ${ROUTER_EVENTS.length} events in ~/.claude/settings.json`);
  console.log(`  ${chalk.green("✓")} scope      ${roots}`);
  console.log(
    `  ${config.auto_init ? chalk.green("✓") : chalk.yellow("○")} auto-init  ${
      config.auto_init ? "new git repos initialize on first touch" : "off"
    }`
  );
  console.log();
  console.log(chalk.dim("  Start Claude Code anywhere. The project follows the files you touch."));
  console.log(chalk.dim("  openwolf global status     what the router is doing"));
  console.log(chalk.dim("  openwolf global uninstall  remove it"));
  console.log();
}

export function globalUninstallCommand(): void {
  const settings = readJSON<Settings>(CLAUDE_SETTINGS, {});
  writeJSONAtomic(CLAUDE_SETTINGS, stripRouter(settings));

  const config = readJSON<Record<string, unknown>>(CONFIG_PATH, {});
  config.enabled = false;
  writeJSONAtomic(CONFIG_PATH, config);

  console.log(chalk.green("✓") + " Router hooks removed from ~/.claude/settings.json");
  console.log(chalk.dim(`  ${ROUTER_PATH} left in place; delete ~/.openwolf/router to remove it.`));
  console.log(chalk.dim("  Per-project .wolf/ directories are untouched."));
}

export function globalStatusCommand(): void {
  const installed = fs.existsSync(ROUTER_PATH);
  const config = readJSON<Record<string, unknown>>(CONFIG_PATH, {});
  const settings = readJSON<Settings>(CLAUDE_SETTINGS, {});
  const registered = Object.values(settings.hooks ?? {}).filter(
    (entries) => Array.isArray(entries) && entries.some(isRouterEntry)
  ).length;

  console.log();
  console.log(chalk.bold("  OpenWolf global router"));
  console.log();
  console.log(`  router file      ${installed ? chalk.green(ROUTER_PATH) : chalk.red("not installed")}`);
  console.log(
    `  registered       ${
      registered ? chalk.green(`${registered}/${ROUTER_EVENTS.length} events`) : chalk.red("no")
    }`
  );
  console.log(`  enabled          ${config.enabled === false ? chalk.yellow("no") : chalk.green("yes")}`);
  console.log(`  auto-init        ${config.auto_init === false ? chalk.yellow("off") : chalk.green("on")}`);
  console.log(`  scope            ${((config.roots as string[]) ?? [HOME]).join(", ")}`);
  console.log(`  cli for autoinit ${config.cli_path ? chalk.dim(String(config.cli_path)) : chalk.red("unset")}`);

  const sessionDir = path.join(OW_DIR, "router-sessions");
  let active = 0;
  const projects = new Set<string>();
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(sessionDir)) {
      const file = path.join(sessionDir, f);
      if (fs.statSync(file).mtimeMs < cutoff) continue;
      active++;
      const s = readJSON<{ project?: string }>(file, {});
      if (s.project) projects.add(s.project);
    }
  } catch {
    /* nothing routed yet */
  }
  console.log(`  routed (24h)     ${active} agent session${active === 1 ? "" : "s"}`);
  for (const p of projects) console.log(`                   ${chalk.dim(p)}`);
  console.log();
}
