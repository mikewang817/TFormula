import { copyFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { describe, expect, it } from "vitest";

const ESC = "\x1b";
const ST = `${ESC}\\`;

describe("reader pseudo-terminal integration", () => {
  it("reloads Markdown after an atomic save without restarting", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-live-"));
    const document = join(directory, "live.md");
    const staged = join(directory, ".live.md.tmp");
    await writeFile(document, "# Initial live document\n\nFirst body.\n");
    const environment = {
      ...process.env,
      TERM: "xterm-256color"
    } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;

    let transcript = "";
    let replacementStarted = false;
    let updated = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", document], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("live reader fixture timed out"));
      }, 7_000);
      terminal.onData((data) => {
        transcript += data;
        if (!replacementStarted && transcript.includes("Initial live document")) {
          replacementStarted = true;
          void (async () => {
            await writeFile(staged, "# Updated live document\n\nSecond body.\n");
            await rename(staged, document);
          })().catch((error) => {
            clearTimeout(timeout);
            terminal.kill();
            reject(error);
          });
        }
        if (!updated && transcript.includes("Updated live document")) {
          updated = true;
          terminal.write("q");
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    try {
      await expect(exited).resolves.toBe(0);
      expect(replacementStarted).toBe(true);
      expect(updated).toBe(true);
      expect(transcript).toContain("Second body.");
      expect(transcript).toContain("updated");
    } finally {
      terminal.kill();
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);

  it("accepts a late Kitty handshake and zooms a scrolling image", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-e2e-"));
    const image = join(directory, "image.png");
    await copyFile(join(process.cwd(), "assets", "tformula-maxwell.png"), image);
    const environment = {
      ...process.env,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty"
    } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;

    let transcript = "";
    let handshakeSent = false;
    let zoomSent = false;
    let scrollSent = false;
    let resetSent = false;
    let shrinkSent = false;
    let quitSent = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", image], {
      name: "xterm-ghostty",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("image zoom fixture timed out"));
      }, 7_000);
      terminal.onData((data) => {
        transcript += data;
        // The alternate-screen transition occurs after the fixed startup
        // probe, so this deliberately exercises the late-ACK reader path.
        if (!handshakeSent && transcript.includes(`${ESC}[?1049h`)) {
          handshakeSent = true;
          terminal.write(
            `${ESC}[6;18;9t${ESC}[4;432;720t`
            + `${ESC}]10;rgb:dddd/eeee/ffff${ST}`
            + `${ESC}]11;rgb:1111/2222/3333${ST}`
            + `${ESC}[?62;4;6;22c${ESC}_Gi=2000000000;OK${ST}`
          );
        }
        if (!zoomSent && transcript.includes(`${ESC}_Ga=p`)) {
          zoomSent = true;
          // Once the terminal owns the canonical image, scrolling and zooming
          // must not decode the source file again. Removing this private test
          // copy turns that performance invariant into an observable failure.
          void rm(image).then(() => terminal.write("+"));
        }
        if (zoomSent && !scrollSent && transcript.includes("image zoom: 125%")) {
          scrollSent = true;
          terminal.write("j");
        }
        if (scrollSent && !resetSent
          && /a=p,[^\x1b]*,x=0,y=[1-9]\d*,w=\d+,h=\d+/u.test(transcript)) {
          resetSent = true;
          terminal.write("0");
        }
        if (resetSent && !shrinkSent && transcript.includes("image size: fit (100%)")) {
          shrinkSent = true;
          terminal.write("-");
        }
        if (shrinkSent && !quitSent && transcript.includes("image zoom: 80%")) {
          quitSent = true;
          terminal.write("q");
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    try {
      await expect(exited).resolves.toBe(0);
      expect(handshakeSent).toBe(true);
      expect(transcript).toContain("image zoom: 125%");
      expect(transcript).toContain("image size: fit (100%)");
      expect(transcript).toContain("image zoom: 80%");
      expect(transcript).not.toContain("asset failed:");
      expect(transcript).toMatch(/a=p,[^\x1b]*,x=0,y=[1-9]\d*,w=\d+,h=\d+/u);
      const uploads = [...transcript.matchAll(/\x1b_Ga=t,[^\x1b]*,i=(\d+)/gu)];
      const placements = [...transcript.matchAll(/\x1b_Ga=p,i=(\d+)/gu)];
      expect(uploads).toHaveLength(1);
      expect(placements.length).toBeGreaterThan(3);
      expect(new Set(placements.map((match) => match[1]))).toEqual(
        new Set([uploads[0]![1]])
      );
      expect(transcript.indexOf("image.png")).toBeLessThan(
        transcript.indexOf(`${ESC}_Ga=t`)
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 8_000);
});
