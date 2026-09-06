/**
 * The web UI ships its own copy of the engine, transcribed to plain JS so the
 * page can run with no build step and no network. Two copies of a model is a
 * standing invitation to drift, and a UI that quietly disagrees with the CLI is
 * worse than no UI at all — the whole product rests on the numbers being the
 * same ones everywhere.
 *
 * So this test extracts the engine out of web/index.html, runs it against the
 * canonical TypeScript engine on the same seed, and requires exact agreement.
 * Not "close": the RNG and the order of draws are identical by construction, so
 * any difference at all means the transcription diverged.
 */

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { simulate } from "../src/engine/simulate.ts";
import { referenceStudent } from "../src/data/corridors/in-us-cs.ts";
import type { SimulationConfig } from "../src/engine/types.ts";

const CONFIG: SimulationConfig = { paths: 1500, horizonMonths: 180, seed: "parity" };

/** Pull the engine section out of the page and make it importable. */
function extractPortedEngine(dir: string): string {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script, "web/index.html must contain an inline script");

  const start = script.indexOf("function createRng");
  const marker = script.indexOf("FORMATTING");
  assert.ok(start >= 0, "ported engine must still start at createRng");
  assert.ok(marker > start, "ported engine must still be followed by the FORMATTING section");

  const end = script.lastIndexOf("/* ===", marker);
  const chunk = script.slice(start, end);
  const file = join(dir, "ported.mjs");
  writeFileSync(file, `${chunk}\nexport { simulate, REFERENCE, LEVERS };\n`, "utf8");
  return file;
}

describe("web UI engine parity", () => {
  const dir = mkdtempSync(join(tmpdir(), "downside-parity-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const file = extractPortedEngine(dir);

  it("agrees with the canonical engine to the last bit", async () => {
    const ported = (await import(pathToFileURL(file).href)) as {
      simulate: (input: unknown, config: SimulationConfig) => Record<string, number>;
      REFERENCE: unknown;
    };

    const canonical = simulate(referenceStudent, CONFIG);
    const web = ported.simulate(ported.REFERENCE, CONFIG);

    const compare: Array<[string, number, number]> = [
      ["pDestJob", canonical.pDestJob, web.pDestJob!],
      ["pVisaSelected", canonical.pVisaSelected, web.pVisaSelected!],
      ["pReturnHome", canonical.pReturnHome, web.pReturnHome!],
      ["pRepayFromHomeIncome", canonical.pRepayFromHomeIncome, web.pRepayFromHomeIncome!],
      ["pStillRepayingAt35", canonical.pStillRepayingAt35, web.pStillRepayingAt35!],
      ["pNeverBreakEven", canonical.pNeverBreakEven, web.pNeverBreakEven!],
      ["pFxShortfall", canonical.pFxShortfall, web.pFxShortfall!],
      ["tailCostYear7", canonical.tailCostYear7, web.tailCostYear7!],
    ];

    for (const [name, a, b] of compare) {
      assert.equal(b, a, `${name} diverged: canonical ${a}, web ${b}`);
    }
  });

  it("carries the same reference scenario the CLI uses", async () => {
    const ported = (await import(pathToFileURL(file).href)) as {
      REFERENCE: {
        loan: { sanctioned: number; nominalRate: number; currency: string };
        program: { pDestOffer: number };
        cost: { tuitionPerYear: number };
        programMonths: number;
      };
    };
    const r = ported.REFERENCE;
    assert.equal(r.loan.sanctioned, referenceStudent.loan.sanctioned);
    assert.equal(r.loan.nominalRate, referenceStudent.loan.nominalRate);
    assert.equal(r.loan.currency, referenceStudent.loan.currency);
    assert.equal(r.program.pDestOffer, referenceStudent.program.pDestOffer);
    assert.equal(r.cost.tuitionPerYear, referenceStudent.cost.tuitionPerYear);
    assert.equal(r.programMonths, referenceStudent.programMonths);
  });

  it("keeps the page's lever set in step with the engine's", async () => {
    const ported = (await import(pathToFileURL(file).href)) as {
      LEVERS: ReadonlyArray<{ id: string }>;
    };
    const { LEVERS } = await import("../src/engine/levers.ts");
    assert.equal(
      ported.LEVERS.length,
      LEVERS.length,
      "web and engine lever counts differ; one side gained or lost a lever",
    );
  });
});
