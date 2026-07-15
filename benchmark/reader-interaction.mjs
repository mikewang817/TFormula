import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import * as pty from "node-pty";

const ESC = "\x1b";
const ST = `${ESC}\\`;

function placementCount(transcript) {
  return [...transcript.matchAll(/\x1b_Ga=p,/gu)].length;
}

function runReader(cacheRoot, label) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const executable = join(process.cwd(), "dist", "cli.js");
    const image = join(process.cwd(), "assets", "tformula-maxwell.png");
    const environment = {
      ...process.env,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      TFORMULA_CACHE_DIR: cacheRoot
    };
    delete environment.TFORMULA_ACTIVE;
    const terminal = pty.spawn(process.execPath, [executable, image], {
      name: "xterm-ghostty",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: environment
    });
    let transcript = "";
    let probeAnswered = false;
    let textMs;
    let firstImageMs;
    let seenPlacements = 0;
    let action;
    let sentAt = 0;
    const interactions = [];
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`${label} reader benchmark timed out`));
    }, 8_000);

    terminal.onData((data) => {
      transcript += data;
      if (!probeAnswered && transcript.includes(`i=2000000000`)) {
        probeAnswered = true;
        terminal.write(
          `${ESC}[6;18;9t${ESC}[4;432;720t`
          + `${ESC}]10;rgb:dddd/eeee/ffff${ST}`
          + `${ESC}]11;rgb:1111/2222/3333${ST}`
          + `${ESC}[?62;4;6;22c${ESC}_Gi=2000000000;OK${ST}`
        );
      }
      if (textMs === undefined && transcript.includes("tformula-maxwell.png")) {
        textMs = performance.now() - started;
      }
      const currentPlacements = placementCount(transcript);
      if (currentPlacements <= seenPlacements) return;
      seenPlacements = currentPlacements;
      const now = performance.now();
      if (firstImageMs === undefined) {
        firstImageMs = now - started;
        action = "zoom";
        sentAt = performance.now();
        terminal.write("+");
        return;
      }
      if (action) interactions.push({ action, ms: now - sentAt });
      const scrolls = interactions.filter(({ action: name }) => name.startsWith("scroll")).length;
      if (action === "zoom" || (action?.startsWith("scroll") && scrolls < 3)) {
        action = `scroll ${scrolls + 1}`;
        sentAt = performance.now();
        terminal.write("j");
      } else {
        action = undefined;
        terminal.write("q");
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`${label} reader exited with ${exitCode}`));
        return;
      }
      const uploads = [...transcript.matchAll(/\x1b_Ga=t,/gu)].length;
      const imageIds = new Set(
        [...transcript.matchAll(/\x1b_Ga=p,i=(\d+)/gu)].map((match) => match[1])
      );
      resolve({
        run: label,
        textMs: Number(textMs?.toFixed(2)),
        firstImageMs: Number(firstImageMs?.toFixed(2)),
        uploads,
        imageIds: imageIds.size,
        meanInteractionMs: Number((interactions.reduce((sum, item) => sum + item.ms, 0)
          / Math.max(1, interactions.length)).toFixed(3))
      });
    });
  });
}

const cacheRoot = await mkdtemp(join(tmpdir(), "tformula-reader-benchmark-"));
try {
  const cold = await runReader(cacheRoot, "cold cache");
  const warm = await runReader(cacheRoot, "warm disk cache");
  console.table([cold, warm]);
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}
