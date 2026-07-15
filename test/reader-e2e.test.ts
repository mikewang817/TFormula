import { join } from "node:path";
import * as pty from "node-pty";
import { describe, expect, it } from "vitest";

const ESC = "\x1b";
const ST = `${ESC}\\`;

describe("reader pseudo-terminal integration", () => {
  it("accepts a late Kitty handshake and zooms a scrolling image", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const image = join(process.cwd(), "assets", "tformula-maxwell.png");
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
          terminal.write("+");
        }
        if (zoomSent && !scrollSent && transcript.includes("image zoom: 125%")) {
          scrollSent = true;
          terminal.write("j");
        }
        if (scrollSent && !resetSent && transcript.includes(",x=0,y=18,")) {
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

    await expect(exited).resolves.toBe(0);
    expect(handshakeSent).toBe(true);
    expect(transcript).toContain("image zoom: 125%");
    expect(transcript).toContain("image size: fit (100%)");
    expect(transcript).toContain("image zoom: 80%");
    expect(transcript).toMatch(/a=p,[^\x1b]*,x=0,y=18,w=\d+,h=\d+/u);
  }, 8_000);
});
