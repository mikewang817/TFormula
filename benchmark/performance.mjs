import { performance } from "node:perf_hooks";
import { detectFormulaRegions } from "../dist/detect.js";
import { OutputCheckpointSplitter } from "../dist/output-checkpoints.js";
import { FormulaScreen } from "../dist/screen.js";
import { detectScreenFormulaRegions } from "../dist/screen-text.js";
import { TerminalCellHoldback } from "../dist/terminal-output.js";
import { kittyTransmitImageChunks } from "../dist/kitty.js";
import { parseMarkdown } from "../dist/reader-document.js";
import { layoutReaderDocument, rescaleReaderImages } from "../dist/reader-layout.js";

function timed(name, iterations, run) {
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = performance.now() - started;
  return {
    benchmark: name,
    iterations,
    totalMs: Number(elapsed.toFixed(2)),
    meanMs: Number((elapsed / iterations).toFixed(4))
  };
}

const plainLines = Array.from(
  { length: 200 },
  (_, row) => `status row ${row} ready successfully completed`
);
const physicalLines = plainLines.slice(0, 60).map((text, row) => ({
  row,
  text,
  isWrapped: false
}));
const denseFormulaLines = Array.from({ length: 32 }, (_, row) => ({
  row,
  text: Array.from(
    { length: 12 },
    (_unused, index) => `\\(x_${index}^2\\) term-${index}`
  ).join(" "),
  isWrapped: false
}));
const terminalChunk = "plain terminal output with numbers 1234567890 ".repeat(220);
const unicodeChunk = "日志🙂e\u0301".repeat(100_000);
const readerSource = [
  "# Reader benchmark",
  "",
  ...Array.from({ length: 500 }, (_, index) =>
    `Paragraph ${index} contains **styled text**, a [link](guide-${index}.md), and enough words to exercise terminal wrapping.`),
  "",
  "![benchmark image](benchmark.png)",
  "",
  "## Tail"
].join("\n\n");
const readerRoot = parseMarkdown(readerSource);
const readerDocument = {
  path: "/tmp/reader-benchmark.md",
  title: "reader-benchmark.md",
  source: readerSource,
  root: readerRoot,
  images: new Map([["benchmark.png", {
    url: "benchmark.png",
    path: "/tmp/benchmark.png",
    width: 2570,
    height: 2194
  }]]),
  math: new Map()
};
const readerOptions = {
  columns: 100,
  viewportRows: 30,
  cell: { width: 9, height: 18, source: "fallback" },
  scale: 1,
  imageScale: 1,
  graphics: true
};
const readerLayout = layoutReaderDocument(readerDocument, readerOptions);
const directPayload = Buffer.alloc(1024 * 1024, 0xa5);

const results = [
  timed("detect: 200 plain rows", 1_000, () => detectFormulaRegions(plainLines)),
  timed("screen-map: 60 plain rows", 2_000, () =>
    detectScreenFormulaRegions(physicalLines, 120)),
  timed("screen-map: 384 inline formulas", 100, () =>
    detectScreenFormulaRegions(denseFormulaLines, 240)),
  timed("cell-holdback: 10KB ASCII", 2_000, () =>
    new TerminalCellHoldback().push(terminalChunk)),
  timed("checkpoint splitter: Unicode stream", 10, () =>
    new OutputCheckpointSplitter(8, 640).push(unicodeChunk)),
  timed("reader parse: 500 paragraphs", 20, () => parseMarkdown(readerSource)),
  timed("reader layout: 500 paragraphs", 50, () =>
    layoutReaderDocument(readerDocument, readerOptions)),
  timed("reader image zoom: local reflow", 1_000, () =>
    rescaleReaderImages(readerLayout, {
      viewportRows: readerOptions.viewportRows,
      cell: readerOptions.cell,
      imageScale: 2
    })),
  timed("Kitty direct chunks: 1MB PNG", 20, () => {
    for (const _packet of kittyTransmitImageChunks(directPayload, 1_400_000_000)) {
      // Consume the lazy packet stream exactly as TerminalWriter does.
    }
  })
];

const capabilities = {
  kittyGraphics: true,
  foreground: "#ffffff",
  background: "#000000",
  cell: { width: 9, height: 18, source: "cell-query" }
};
const screen = new FormulaScreen({
  cols: 160,
  rows: 60,
  capabilities,
  scale: 1,
  writeOuter: () => undefined
});
try {
  await screen.write(plainLines.slice(0, 60).join("\r\n"));
  await screen.flushScan();
  const started = performance.now();
  for (let index = 0; index < 500; index += 1) await screen.flushScan();
  const elapsed = performance.now() - started;
  results.push({
    benchmark: "FormulaScreen: 160x60 plain viewport",
    iterations: 500,
    totalMs: Number(elapsed.toFixed(2)),
    meanMs: Number((elapsed / 500).toFixed(4))
  });
} finally {
  screen.dispose();
}

console.table(results);
