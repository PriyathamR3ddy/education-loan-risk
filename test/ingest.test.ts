import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annualizeWage, ingestLca, parseCsvLine } from "../ingest/lca.ts";

describe("csv parsing", () => {
  it("splits plain fields", () => {
    assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]);
  });

  it("keeps commas inside quoted fields", () => {
    assert.deepEqual(parseCsvLine('a,"BIG CORP, INC.",c'), ["a", "BIG CORP, INC.", "c"]);
  });

  it("unescapes doubled quotes", () => {
    assert.deepEqual(parseCsvLine('a,"say ""hi""",c'), ["a", 'say "hi"', "c"]);
  });

  it("preserves empty trailing fields", () => {
    assert.deepEqual(parseCsvLine("a,,"), ["a", "", ""]);
  });
});

describe("wage annualization", () => {
  it("passes through an annual wage", () => {
    assert.equal(annualizeWage("120000", "Year"), 120_000);
  });

  it("annualizes hourly at full time", () => {
    assert.equal(annualizeWage("60", "Hour"), 60 * 2080);
  });

  it("strips currency formatting", () => {
    assert.equal(annualizeWage("$135,000.00", "Year"), 135_000);
  });

  it("rejects unparseable and out-of-range values", () => {
    assert.equal(annualizeWage("", "Year"), null);
    assert.equal(annualizeWage("abc", "Year"), null);
    assert.equal(annualizeWage("120000", "Fortnight"), null);
    assert.equal(annualizeWage("5", "Year"), null, "sub-minimum annual is a typo");
    assert.equal(annualizeWage("99000000", "Year"), null, "eight figures is a typo");
  });
});

describe("lca ingestion", () => {
  const dir = mkdtempSync(join(tmpdir(), "downside-lca-"));
  const file = join(dir, "lca.csv");

  after(() => rmSync(dir, { recursive: true, force: true }));

  const header =
    "CASE_STATUS,SOC_CODE,JOB_TITLE,WAGE_RATE_OF_PAY_FROM,WAGE_UNIT_OF_PAY,WORKSITE_STATE,FULL_TIME_POSITION,EMPLOYER_NAME";

  const rows: string[] = [header];
  // 200 in-scope certified rows with a known linear wage spread.
  for (let i = 0; i < 200; i++) {
    const wage = 80_000 + i * 500; // 80,000 .. 179,500
    rows.push(
      `CERTIFIED,15-1252,Software Engineer,${wage},Year,CA,Y,"ACME, INC."`,
    );
  }
  // Rows that must all be excluded, one per rejection rule.
  rows.push("DENIED,15-1252,Software Engineer,999999,Year,CA,Y,DENIED CO");
  rows.push("CERTIFIED,13-2011,Accountant,90000,Year,CA,Y,WRONG SOC CO");
  rows.push("CERTIFIED,15-1252,Software Engineer,95000,Year,TX,Y,WRONG STATE CO");
  rows.push("CERTIFIED,15-1252,Intern,40000,Year,CA,N,PART TIME CO");
  rows.push("CERTIFIED,15-1252,Software Engineer,notanumber,Year,CA,Y,BAD WAGE CO");
  writeFileSync(file, rows.join("\n") + "\n", "utf8");

  it("keeps only certified, full-time, in-scope rows", async () => {
    const r = await ingestLca({ file, soc: ["15-1252"], states: ["CA"], vintage: "FY2024" });
    assert.equal(r.rowsKept, 200);
    assert.equal(r.rowsRead, 205);
  });

  it("recovers the percentiles of the underlying spread", async () => {
    const r = await ingestLca({ file, soc: ["15-1252"], states: ["CA"], vintage: "FY2024" });
    const at = (p: number) => r.curve.points.find((pt) => pt.p === p)?.v ?? NaN;
    // Median of 80,000..179,500 in 500 steps.
    assert.ok(Math.abs(at(0.5) - 129_750) < 300, `median ${at(0.5)}`);
    assert.ok(Math.abs(at(0.1) - 89_950) < 300, `p10 ${at(0.1)}`);
    assert.ok(Math.abs(at(0.9) - 169_550) < 300, `p90 ${at(0.9)}`);
  });

  it("emits a non-placeholder source ref carrying its vintage and sample size", async () => {
    const r = await ingestLca({ file, soc: ["15-1252"], states: ["CA"], vintage: "FY2024" });
    assert.equal(r.curve.source.placeholder, false);
    assert.equal(r.curve.source.kind, "public-filing");
    assert.equal(r.curve.source.vintage, "FY2024");
    assert.match(r.curve.source.label, /n=200/);
    assert.match(r.curve.source.label, /excludes bonus and equity/);
  });

  it("counts sponsoring employers, handling quoted names", async () => {
    const r = await ingestLca({ file, soc: ["15-1252"], states: ["CA"], vintage: "FY2024" });
    assert.deepEqual(r.topEmployers[0], { employer: "ACME, INC.", n: 200 });
  });

  it("refuses to publish a curve from too thin a sample", async () => {
    await assert.rejects(
      () => ingestLca({ file, soc: ["99-9999"], states: [], vintage: "FY2024" }),
      /too thin to publish/,
    );
  });
});
