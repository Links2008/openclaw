import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [reportPath, exitCode] = process.argv.slice(2);
assert.ok(reportPath, "必须传入 Vitest JSON 报告路径");
assert.equal(exitCode, "1", "只有断言失败可以作为红灯证据");
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert.equal(report.success, false);
assert.equal(report.numFailedTests, 4);
assert.equal(report.numPassedTests, 1);
assert.equal(report.testResults.length, 1);
const suite = report.testResults[0];
assert.match(suite.name, /\/src\/plugins\/management-service\.uninstall-ownership\.test\.ts$/u);
const selected = suite.assertionResults.filter((test) =>
  test.title.startsWith("keeps uninstall scope for a "),
);
assert.equal(selected.length, 5, "必须执行全部五个目标用例");
const collisions = selected.filter(({ title }) => title.includes("exact record: true"));
assert.equal(collisions.length, 4);
for (const test of collisions) {
  assert.equal(test.status, "failed");
  const failure = test.failureMessages.join("\n");
  assert.match(failure, /expected 1st "vi\.fn\(\)" call to have been called with/u);
  assert.match(failure, /management-service\.uninstall-ownership\.test\.ts:\d+:\d+/u);
}
const control = selected.find(
  ({ title }) => title.includes("exact record: false"),
);
assert.ok(control, "缺少普通别名对照");
assert.equal(control.status, "passed");
assert.equal(control.failureMessages.length, 0);
console.log("红灯确认：四个 exact-record 碰撞均在禁用配置断言失败，普通别名对照通过。");
