import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { describe, expect, it } from "vitest";

const ESC = "\x1b";
const ST = `${ESC}\\`;

describe("reader pseudo-terminal integration", () => {
  it("navigates folders lazily and restores the selected parent entry", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-files-e2e-"));
    const first = join(directory, "first.md");
    const chapters = join(directory, "chapters");
    await Promise.all([
      mkdir(join(directory, "alpha")),
      mkdir(chapters)
    ]);
    await Promise.all([
      writeFile(first, "# First document\n"),
      writeFile(join(directory, "second.md"), "# Second document\n"),
      writeFile(join(chapters, "nested.md"), "# Opened from nested folder\n"),
      writeFile(join(directory, "app.ts"), "export {};\n")
    ]);
    const environment = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;
    let transcript = "";
    let stage = 0;
    let checkpoint = 0;
    let quitSent = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", first], {
      name: "xterm-256color",
      cols: 72,
      rows: 16,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("file list reader fixture timed out"));
      }, 5_000);
      terminal.onData((data) => {
        transcript += data;
        if (stage === 0 && transcript.includes(`${ESC}[?1049h`)) {
          stage = 1;
          terminal.write("l");
        }
        if (stage === 1 && transcript.includes("chapters/")
          && transcript.includes("2 folders · 2 files")) {
          stage = 2;
          checkpoint = transcript.length;
          terminal.write(`${ESC}[H${ESC}[B${ESC}[C`);
        }
        if (stage === 2 && transcript.slice(checkpoint).includes("nested.md")) {
          stage = 3;
          checkpoint = transcript.length;
          terminal.write(`${ESC}[D`);
        }
        if (stage === 3 && transcript.slice(checkpoint).includes("second.md")
          && transcript.slice(checkpoint).includes("2 folders · 2 files")) {
          stage = 4;
          checkpoint = transcript.length;
          // The parent restores chapters/ as the selection, so Right enters it again.
          terminal.write(`${ESC}[C`);
        }
        if (stage === 4 && transcript.slice(checkpoint).includes("nested.md")) {
          stage = 5;
          terminal.write(`${ESC}[C`);
        }
        if (stage === 5 && !quitSent && transcript.includes("Opened from nested folder")) {
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
      expect(transcript).toContain("Files");
      expect(transcript).toContain("alpha/");
      expect(transcript).toContain("chapters/");
      expect(transcript).toContain("first.md");
      expect(transcript).toContain("second.md");
      expect(transcript).toContain("nested.md");
      expect(transcript).not.toContain("app.ts");
      expect(transcript).toContain("Opened from nested folder");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 6_000);

  it("keeps a grid header visible while moving its horizontal column window", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-grid-e2e-"));
    const csv = join(directory, "wide.csv");
    await writeFile(csv, [
      "first,second,third,fourth",
      "alpha,a long second value,3,tail",
      "beta,another long value,4,end"
    ].join("\n"));
    const environment = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;
    let transcript = "";
    let moved = false;
    let quit = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", csv], {
      name: "xterm-256color",
      cols: 36,
      rows: 12,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("grid reader fixture timed out"));
      }, 5_000);
      terminal.onData((data) => {
        transcript += data;
        if (!moved && transcript.includes(`${ESC}[?1049h`)) {
          moved = true;
          terminal.write(`${ESC}[C`);
        }
        if (moved && !quit && transcript.includes("column window starts at 2/4")) {
          quit = true;
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
      expect(transcript).toContain("column window starts at 2/4");
      expect(transcript).toContain("second");
      expect(transcript).toContain("a long second value");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 6_000);

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
