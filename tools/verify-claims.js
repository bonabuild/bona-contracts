/**
 * Turns a project convention into an enforced rule.
 *
 * This repository claims a specific number of passing tests in its README,
 * in SECURITY.md and in docs/. Those numbers are load-bearing: they back the
 * statement that every safety claim on the website has a test here. A claim
 * that drifts from reality is worse than no claim at all.
 *
 * So CI runs the suite, reads the real count, and fails the build if any
 * published number disagrees. Deleting a test now forces the claim it backs
 * to be updated in the same commit — which is what the convention always
 * said, and what nothing previously enforced.
 *
 *   node tools/verify-claims.js <path-to-test-output>
 */
const fs = require("node:fs");
const path = require("node:path");

const FILES = ["README.md", "SECURITY.md", "docs/audit-status.md", "docs/contract-design.md"];
const CLAIM = /\b(\d{2,4})\s+(?:automated\s+)?tests?\b/gi;

const outputPath = process.argv[2];
if (!outputPath) {
  console.error("usage: node tools/verify-claims.js <test-output-file>");
  process.exit(2);
}

const output = fs.readFileSync(outputPath, "utf8");
const passing = output.match(/(\d+)\s+passing/);
const failing = output.match(/(\d+)\s+failing/);

if (!passing) {
  console.error("FAIL: could not find a passing count in the test output.");
  process.exit(1);
}
if (failing) {
  console.error(`FAIL: ${failing[1]} test(s) failing.`);
  process.exit(1);
}

const actual = Number(passing[1]);
console.log(`Test suite reports ${actual} passing.\n`);

let bad = 0;
for (const f of FILES) {
  const p = path.join(__dirname, "..", f);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(CLAIM)) {
      const claimed = Number(m[1]);
      const ok = claimed === actual;
      if (!ok) bad++;
      console.log(`${ok ? "ok  " : "FAIL"}  ${f}:${i + 1}  claims ${claimed}`);
      if (!ok) console.log(`        → suite has ${actual}. Update the claim, or restore the test.`);
    }
  });
}

if (bad) {
  console.error(`\n${bad} published claim(s) disagree with the suite.`);
  process.exit(1);
}
console.log("\nEvery published test count matches the suite.");
