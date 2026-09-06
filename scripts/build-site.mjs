/**
 * Build the standalone site from web/index.html.
 *
 * web/index.html is authored for a host that supplies the document shell: it
 * starts at <title> and has no doctype, <html>, <head> or <body> of its own.
 * That is deliberate and must stay that way — the parity test and the Artifact
 * publish both read that file directly.
 *
 * Served raw by GitHub Pages the same file would render in quirks mode, where
 * box sizing and percentage heights quietly change and the layout drifts. So
 * this wraps it in a real document rather than editing the source: one input,
 * two outputs, no divergence.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "web", "index.html");
const outDir = join(root, "dist");
const out = join(outDir, "index.html");

const body = readFileSync(src, "utf8");

if (/<!doctype|<html[\s>]|<body[\s>]/i.test(body)) {
  throw new Error(
    "web/index.html has grown its own document shell. It must stay a fragment " +
      "so the Artifact host can wrap it; remove the tags or retire this script.",
  );
}

const DESCRIPTION =
  "A Monte Carlo simulator for the tail risk of a foreign education loan: the " +
  "probability you repay a dollar-priced degree on a rupee income.";

// A pencil-and-paper favicon would need a file; an emoji in an inline SVG keeps
// the whole site to a single request-free document.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="52" font-size="52">📉</text></svg>',
  );

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${DESCRIPTION}">
<meta name="robots" content="noindex">
<meta property="og:title" content="Downside">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:type" content="website">
<link rel="icon" href="${FAVICON}">
<style>
  /* The same reset the authoring host applies, so the page renders identically
     in both places. Everything else lives in the document itself. */
  :root { color-scheme: light; }
  body { margin: 0; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
${body}
</body>
</html>
`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(out, page, "utf8");
// Pages serves the uploaded artifact directly, but .nojekyll costs nothing and
// removes a whole class of surprise about underscore-prefixed paths.
writeFileSync(join(outDir, ".nojekyll"), "", "utf8");

console.log(`built dist/index.html (${(page.length / 1024).toFixed(1)} KB)`);
