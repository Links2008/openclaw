import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 仅在无用户凭据的 Linux Actions runner 上运行真实 CLI/Gateway。
assert.equal(process.platform, "linux", "此脚本禁止在用户 Windows 主机执行");
assert.equal(process.env.GITHUB_ACTIONS, "true", "需要专用 GitHub Actions runner");
const mode = process.argv[2];
assert.ok(mode === "baseline" || mode === "fixed", "参数必须为 baseline 或 fixed");
const cwd = process.cwd();
const runnerTemp = path.resolve(process.env.RUNNER_TEMP ?? "");
assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
const outputDir = path.resolve(process.env.PROOF_OUTPUT_DIR ?? path.join(runnerTemp, "p1-uninstall-proof"));
assert.ok(outputDir.startsWith(`${runnerTemp}${path.sep}`), "结果必须写入 runner 临时目录");
await mkdir(outputDir, { recursive: true });
const root = await mkdtemp(path.join(runnerTemp, `openclaw-uninstall-${mode}-`));
const home = path.join(root, "home");
const state = path.join(root, "state");
const configPath = path.join(state, "openclaw.json");
const token = randomBytes(24).toString("hex");
const nonce = randomBytes(12).toString("hex");
const orphanId = "scope-orphan";
const liveId = "scope-live";
const probeMethod = "scopeLive.probe";
const report = { mode, root, stage: "prepare", success: false, commands: [] };
const redact = (text) => String(text).replaceAll(token, "<synthetic-token>");
const save = () => writeFile(path.join(outputDir, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  XDG_DATA_HOME: path.join(root, "xdg-data"),
  XDG_STATE_HOME: path.join(root, "xdg-state"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_HOME: home,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_VITEST_RUNTIME: "node",
  NO_COLOR: "1",
  CI: "true",
  LANG: "C.UTF-8",
};
// 仅继承工具链位置，不继承 token、服务地址、用户配置或模型凭据。
for (const key of ["PNPM_HOME", "COREPACK_HOME"]) {
  if (process.env[key]) env[key] = process.env[key];
}
await Promise.all([home, state, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
  env.XDG_DATA_HOME, env.XDG_STATE_HOME].map((dir) => mkdir(dir, { recursive: true })));

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function command(label, args, { allowFailure = false, timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  const child = spawn("pnpm", ["--silent", "openclaw", ...args], {
    cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => { timedOut = true; signalGroup(child, "SIGKILL"); }, timeoutMs);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timer));
  const entry = { label, args, code, timedOut, elapsedMs: Date.now() - started };
  report.commands.push(entry);
  await writeFile(path.join(outputDir, `${label}.stdout.txt`), redact(stdout));
  await writeFile(path.join(outputDir, `${label}.stderr.txt`), redact(stderr));
  await save();
  assert.equal(timedOut, false, `${label} 超时，不能作为产品复现`);
  if (!allowFailure) assert.equal(code, 0, `${label} 失败: ${redact(stderr || stdout)}`);
  return { ...entry, stdout, stderr };
}

const jsonCommand = async (label, args) => JSON.parse((await command(label, [...args, "--json"])).stdout);
const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
const readRegistry = async (label, refresh = false) => {
  const result = await jsonCommand(label, ["plugins", "registry", ...(refresh ? ["--refresh"] : [])]);
  const registry = refresh ? result.registry : result.current;
  assert.ok(registry?.installRecords && Array.isArray(registry.plugins), `${label}: registry 缺少结构化数据`);
  return registry;
};

async function writePlugin(id, live) {
  const dir = path.join(root, "sources", id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: id, version: "1.0.0", type: "commonjs", main: "index.cjs",
    openclaw: { extensions: ["./index.cjs"] },
  }));
  await writeFile(path.join(dir, "openclaw.plugin.json"), JSON.stringify({
    id, name: id,
    ...(live ? { channels: [orphanId], activation: { onStartup: true } } : {}),
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  }));
  await writeFile(path.join(dir, "index.cjs"), `module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    ${live ? `api.registerGatewayMethod(${JSON.stringify(probeMethod)}, ({ respond }) => {
      respond(true, { pluginId: ${JSON.stringify(id)}, nonce: ${JSON.stringify(nonce)}, node: process.version });
    }, { scope: "operator.read", profileAccess: "independent" });` : ""}
  }
};\n`);
  return dir;
}

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const selected = server.address().port;
    server.close((error) => error ? reject(error) : resolve(selected));
  });
});
let gateway;
let gatewayStdout = "";
let gatewayStderr = "";
let gatewayError;
try {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", env }).trim();
  const buildInfo = JSON.parse(await readFile(path.join(cwd, "dist", "build-info.json"), "utf8"));
  assert.equal(buildInfo.commit, sha, "构建身份必须与当前源码一致");
  if (process.env.PROOF_EXPECTED_SHA) assert.equal(sha, process.env.PROOF_EXPECTED_SHA);
  report.source = { sha, buildInfo, harnessNode: process.version };
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace: path.join(root, "workspace"), heartbeat: { every: "0m" } } },
    cron: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
  }, null, 2));
  report.stage = "install-fixtures";
  const orphanSource = await writePlugin(orphanId, false);
  const liveSource = await writePlugin(liveId, true);
  await command("install-orphan", ["plugins", "install", orphanSource, "--force", "--accept-capabilities", "--no-enable"]);
  await command("install-live", ["plugins", "install", liveSource, "--force", "--accept-capabilities"]);
  await command("enable-live", ["plugins", "enable", liveId, "--accept-capabilities"]);
  if (Object.hasOwn((await readConfig()).plugins?.entries ?? {}, orphanId)) {
    await command("remove-orphan-policy", ["config", "unset", `plugins.entries.${orphanId}`]);
  }
  await command("allow-live-only", ["config", "set", "plugins.allow", JSON.stringify([liveId]), "--strict-json"]);
  const installed = await readRegistry("registry-installed", true);
  assert.ok(installed.installRecords[orphanId]?.installPath, "必须先经真实安装生成 A durable record");
  assert.ok(installed.installRecords[liveId], "B 安装记录不存在");

  report.stage = "make-orphan";
  // 仅移动本次 runner 临时 fixture，保留产品自己的 durable 安装记录。
  const moving = [...new Set([installed.installRecords[orphanId].installPath, orphanSource].map((value) => path.resolve(value)))];
  for (const [index, source] of moving.entries()) {
    assert.ok(source.startsWith(`${root}${path.sep}`) && source !== state && source !== home);
    await rename(source, path.join(root, `parked-orphan-${index}`));
  }
  const before = await readRegistry("registry-orphan", true);
  assert.ok(before.installRecords[orphanId]);
  assert.ok(!before.plugins.some((plugin) => plugin.pluginId === orphanId), "A 仍被发现，碰撞前提不成立");
  const live = before.plugins.find((plugin) => plugin.pluginId === liveId);
  assert.ok(live, "B 必须仍被发现");
  assert.ok(live.contributions?.channels.includes(orphanId), "B 必须声明与 A record 相同的 channel alias");
  const configBefore = await readConfig();
  assert.ok(!Object.hasOwn(configBefore.plugins.entries, orphanId), "匹配报告者的无 A policy entry 前态");
  assert.equal(configBefore.plugins.entries[liveId].enabled, true);
  report.precondition = { orphanRecord: before.installRecords[orphanId], liveRecord: before.installRecords[liveId], livePlugin: live };

  report.stage = "gateway-start";
  gateway = spawn("pnpm", ["--silent", "openclaw", "gateway", "run"], {
    cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", (data) => { gatewayStdout += data; });
  gateway.stderr.on("data", (data) => { gatewayStderr += data; });
  gateway.once("error", (error) => { gatewayError = error; });
  const deadline = Date.now() + 360_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (gatewayError) throw gatewayError;
    assert.ok(gateway.exitCode === null && gateway.signalCode === null, `Gateway 提前退出: ${redact(gatewayStderr)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { ready = true; break; }
    } catch { /* 就绪前的短暂连接失败不是产品结论。 */ }
    await sleep(1_000);
  }
  assert.ok(ready, `Gateway 未就绪: ${redact(gatewayStderr)}`);
  const probe = (label) => jsonCommand(label, ["gateway", "call", probeMethod, "--timeout", "30000"]);
  const expectedProbe = { pluginId: liveId, nonce, node: process.version };
  assert.deepEqual(await probe("probe-before"), expectedProbe);
  report.stage = "uninstall";
  const beforeDryRun = await readConfig();
  assert.deepEqual(beforeDryRun.plugins.entries[liveId], configBefore.plugins.entries[liveId]);
  const dryRun = await command("uninstall-dry-run", ["plugins", "uninstall", orphanId, "--dry-run", "--keep-files"]);
  assert.match(dryRun.stdout, /Plugin: scope-orphan(?:\r?\n|$)/);
  assert.match(dryRun.stdout, /Dry run, no changes made\./);
  assert.deepEqual(await readConfig(), beforeDryRun, "dry-run 不应写配置");
  const actual = await command("uninstall-actual", ["plugins", "uninstall", orphanId, "--force", "--keep-files"], { allowFailure: mode === "baseline", timeoutMs: 660_000 });
  assert.doesNotMatch(actual.stdout, /Saved for the next Gateway start\./, "不能以离线卸载代替 Gateway 路径");
  const configAfter = await readConfig();
  report.postcondition = { uninstallExitCode: actual.code, plugins: configAfter.plugins };
  if (mode === "baseline") {
    assert.equal(configAfter.plugins.entries[liveId].enabled, false, "基线必须实际误禁用 B，命令失败本身不算复现");
    report.targetMismatchReproduced = true;
    if (actual.code === 0) assert.match(actual.stdout, /Uninstalled plugin "scope-live"\./);
    let after;
    try { after = await readRegistry("registry-after"); }
    catch (error) { report.postcondition.registryReadError = redact(error.stack ?? error); }
    if (after) {
      assert.deepEqual(after.installRecords[orphanId], before.installRecords[orphanId], "基线应留下原本请求删除的 A record");
      report.postcondition.orphanRecord = after.installRecords[orphanId];
      report.postcondition.liveRecord = after.installRecords[liveId] ?? null;
    }
    const unavailable = await command("probe-after", ["gateway", "call", probeMethod, "--timeout", "30000", "--json"], { allowFailure: true });
    assert.notEqual(unavailable.code, 0, "被错选禁用的 B 不应继续提供 probe");
    report.postcondition.probeExitCode = unavailable.code;
  } else {
    assert.match(actual.stdout, /Uninstalled plugin "scope-orphan"\./);
    assert.deepEqual(configAfter.plugins.entries[liveId], configBefore.plugins.entries[liveId]);
    assert.equal(configAfter.plugins.entries[orphanId].enabled, false);
    const after = await readRegistry("registry-after");
    assert.ok(!Object.hasOwn(after.installRecords, orphanId), "修复后应删除 A record");
    assert.deepEqual(after.installRecords[liveId], before.installRecords[liveId], "B record 不应改变");
    assert.deepEqual(await probe("probe-after"), expectedProbe);
    const reload = await jsonCommand("reload-live", ["plugins", "reload", liveId]);
    assert.ok(Number.isFinite(reload.runtime?.generation), "reload 必须返回运行时 generation");
    assert.notEqual(reload.restartRequired, true, "reload 不应要求重启");
    assert.deepEqual(await probe("probe-after-reload"), expectedProbe);
    report.postcondition.liveRecord = after.installRecords[liveId];
    report.postcondition.reload = reload;
  }
  report.stage = "complete";
  report.success = true;
} catch (error) {
  report.error = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (gateway?.pid) {
    const closed = new Promise((resolve) => {
      if (gateway.exitCode !== null || gateway.signalCode !== null) resolve();
      else gateway.once("close", resolve);
    });
    signalGroup(gateway, "SIGTERM");
    await Promise.race([closed, sleep(20_000)]);
    signalGroup(gateway, "SIGKILL");
  }
  await writeFile(path.join(outputDir, "gateway.stdout.txt"), redact(gatewayStdout));
  await writeFile(path.join(outputDir, "gateway.stderr.txt"), redact(gatewayStderr));
  await save();
  console.log(JSON.stringify({ mode, success: report.success, stage: report.stage, outputDir, error: report.error }, null, 2));
}
