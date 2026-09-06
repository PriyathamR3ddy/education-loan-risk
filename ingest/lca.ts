/**
 * Ingest DOL OFLC LCA disclosure data into a wage percentile curve.
 *
 * WHY THIS SOURCE
 * ---------------
 * Every other wage number available to a prospective student is produced by
 * someone with a stake in their decision: the university's placement report, the
 * consultant's brochure, the lender's marketing. LCA filings are different. An
 * employer files them with the Department of Labor to sponsor a worker, under
 * penalty of perjury, and the Department publishes them quarterly. Nobody files
 * an LCA to impress an applicant.
 *
 * WHAT THIS SOURCE IS NOT
 * -----------------------
 * Read this before quoting any number this script produces.
 *
 *  1. An LCA wage is the OFFERED wage on the petition. It is a floor the
 *     employer commits to, not total compensation. Bonus, equity and most
 *     variable pay are excluded, so these figures understate real earnings at
 *     companies that pay heavily in stock. Do not label the output "salary".
 *  2. The population is workers being sponsored. It is therefore conditional on
 *     having cleared the employment AND sponsorship branches already. Feeding
 *     this curve into the engine as `firstYearWage` is correct precisely because
 *     the engine samples it only on the branch where those things happened, but
 *     it is the wrong curve for any unconditional question.
 *  3. A filing is not a hire. Certified LCAs include positions never filled and
 *     duplicate filings for the same role.
 *  4. There is no graduation year and no institution. Joining a program to its
 *     graduates' wages needs an employer-and-title bridge, which is what the
 *     contributed alumni data is ultimately for. Until that bridge exists, treat
 *     this as an occupation-and-geography curve, not a program-level one.
 *
 * USAGE
 * -----
 *   node ingest/lca.ts --file LCA_Disclosure_FY2024.csv --soc 15-1252,15-1211 \
 *        --state CA,WA,NY --out src/data/generated/wage-cs.json
 *
 * The source files are published as .xlsx at
 * https://www.dol.gov/agencies/eta/foreign-labor/performance and run to
 * hundreds of MB, so convert to CSV first and let this stream it.
 */

import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { PercentileCurve, SourceRef } from "../src/engine/types.ts";

/** Percentiles emitted, matching the shape the engine samples. */
const OUTPUT_PERCENTILES = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

/** Hours per year used to annualize an hourly offered wage. */
const FULL_TIME_HOURS_PER_YEAR = 2080;

const PAY_PERIOD_MULTIPLIER: Record<string, number> = {
  YEAR: 1,
  MONTH: 12,
  "BI-WEEKLY": 26,
  BIWEEKLY: 26,
  WEEK: 52,
  HOUR: FULL_TIME_HOURS_PER_YEAR,
};

/**
 * Split one CSV line, honouring quoted fields and doubled quote escapes.
 * Written by hand because adding a dependency to read a government CSV is not a
 * trade worth making, and the dialect here is plain RFC 4180.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/** Annualize an offered wage. Returns null when the row is unusable. */
export function annualizeWage(amount: string, unit: string): number | null {
  const value = Number(amount.replace(/[$,]/g, "").trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  const mult = PAY_PERIOD_MULTIPLIER[unit.trim().toUpperCase()];
  if (mult === undefined) return null;
  const annual = value * mult;
  // Filings contain transcription errors in both directions. A sub-minimum-wage
  // annual figure or an eight-figure one is a data-entry artefact, not a job.
  if (annual < 15_000 || annual > 2_000_000) return null;
  return annual;
}

/** Column names vary by fiscal year, so resolve each one by trying aliases. */
function resolveColumns(header: readonly string[]) {
  const idx = (...names: string[]): number => {
    for (const n of names) {
      const i = header.findIndex((h) => h.trim().toUpperCase() === n);
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    status: idx("CASE_STATUS"),
    soc: idx("SOC_CODE", "LCA_CASE_SOC_CODE"),
    wageFrom: idx("WAGE_RATE_OF_PAY_FROM", "LCA_CASE_WAGE_RATE_FROM"),
    wageUnit: idx("WAGE_UNIT_OF_PAY", "LCA_CASE_WAGE_RATE_UNIT", "PW_UNIT_OF_PAY"),
    state: idx("WORKSITE_STATE", "WORKSITE_STATE_1", "LCA_CASE_WORKLOC1_STATE"),
    fullTime: idx("FULL_TIME_POSITION"),
    employer: idx("EMPLOYER_NAME"),
    title: idx("JOB_TITLE"),
  };
}

export interface IngestOptions {
  file: string;
  /** SOC codes to keep, e.g. ["15-1252"]. Empty keeps all. */
  soc: readonly string[];
  /** Worksite states to keep, e.g. ["CA"]. Empty keeps all. */
  states: readonly string[];
  /** Fiscal year label recorded on the emitted source ref. */
  vintage: string;
}

export interface IngestResult {
  curve: PercentileCurve;
  rowsRead: number;
  rowsKept: number;
  topEmployers: Array<{ employer: string; n: number }>;
}

export async function ingestLca(opts: IngestOptions): Promise<IngestResult> {
  const socFilter = new Set(opts.soc.map((s) => s.trim().toUpperCase()));
  const stateFilter = new Set(opts.states.map((s) => s.trim().toUpperCase()));

  const rl = createInterface({
    input: createReadStream(opts.file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let columns: ReturnType<typeof resolveColumns> | null = null;
  const wages: number[] = [];
  const employers = new Map<string, number>();
  let rowsRead = 0;

  for await (const line of rl) {
    if (line.trim() === "") continue;
    const cells = parseCsvLine(line);
    if (columns === null) {
      columns = resolveColumns(cells);
      if (columns.wageFrom < 0 || columns.soc < 0) {
        throw new Error(
          "could not locate SOC_CODE and WAGE_RATE_OF_PAY_FROM columns; is this an LCA disclosure export?",
        );
      }
      continue;
    }
    rowsRead++;

    const status = (cells[columns.status] ?? "").trim().toUpperCase();
    if (status !== "CERTIFIED" && status !== "CERTIFIED - WITHDRAWN") continue;

    if (columns.fullTime >= 0) {
      const ft = (cells[columns.fullTime] ?? "").trim().toUpperCase();
      if (ft === "N") continue;
    }

    const soc = (cells[columns.soc] ?? "").trim().toUpperCase();
    if (socFilter.size > 0 && !socFilter.has(soc)) continue;

    if (stateFilter.size > 0 && columns.state >= 0) {
      const st = (cells[columns.state] ?? "").trim().toUpperCase();
      if (!stateFilter.has(st)) continue;
    }

    const annual = annualizeWage(cells[columns.wageFrom] ?? "", cells[columns.wageUnit] ?? "");
    if (annual === null) continue;

    wages.push(annual);
    if (columns.employer >= 0) {
      const e = (cells[columns.employer] ?? "").trim();
      if (e !== "") employers.set(e, (employers.get(e) ?? 0) + 1);
    }
  }

  if (wages.length < 100) {
    throw new Error(
      `only ${wages.length} usable rows matched; too thin to publish a curve. Widen the SOC or state filter.`,
    );
  }

  wages.sort((a, b) => a - b);
  const pick = (p: number): number => {
    const i = p * (wages.length - 1);
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? wages[lo]! : wages[lo]! + (i - lo) * (wages[hi]! - wages[lo]!);
  };

  const source: SourceRef = {
    id: `dol-oflc-lca-${opts.vintage}`,
    label: `DOL OFLC LCA certified offered wages, SOC ${opts.soc.join("/") || "all"}${
      opts.states.length > 0 ? `, worksite ${opts.states.join("/")}` : ""
    }, n=${wages.length}. Offered wage floor, excludes bonus and equity.`,
    kind: "public-filing",
    url: "https://www.dol.gov/agencies/eta/foreign-labor/performance",
    vintage: opts.vintage,
    placeholder: false,
  };

  return {
    curve: {
      points: OUTPUT_PERCENTILES.map((p) => ({ p, v: Math.round(pick(p)) })),
      source,
    },
    rowsRead,
    rowsKept: wages.length,
    topEmployers: [...employers.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([employer, n]) => ({ employer, n })),
  };
}

// --- CLI ------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith("lca.ts") ?? false;
if (isMain) {
  const arg = (name: string, fallback = ""): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
  };

  const file = arg("file");
  if (file === "") {
    console.error("usage: node ingest/lca.ts --file <csv> [--soc a,b] [--state CA,NY] [--out path]");
    console.error("");
    console.error("Source files: https://www.dol.gov/agencies/eta/foreign-labor/performance");
    console.error("They ship as .xlsx. Convert to CSV first; this streams the CSV.");
    process.exit(1);
  }

  const split = (s: string) => (s === "" ? [] : s.split(",").map((x) => x.trim()));

  const result = await ingestLca({
    file,
    soc: split(arg("soc")),
    states: split(arg("state")),
    vintage: arg("vintage", "unknown"),
  });

  console.error(
    `read ${result.rowsRead.toLocaleString("en-US")} rows, kept ${result.rowsKept.toLocaleString("en-US")}`,
  );
  console.error("top sponsoring employers in this slice:");
  for (const e of result.topEmployers) {
    console.error(`  ${String(e.n).padStart(6)}  ${e.employer}`);
  }

  const out = arg("out");
  const json = JSON.stringify(result.curve, null, 2);
  if (out === "") {
    console.log(json);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json + "\n", "utf8");
    console.error(`wrote ${out}`);
  }
}
