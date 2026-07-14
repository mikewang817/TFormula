import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { isRuntimeProbeQueryId } from "../src/probe.js";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const CHILD_OSC = `${ESC}]0;agent-title-with-ESC-[2J-and-iVBORw0KGgo${ST}`;
const CHILD_APC = `${ESC}_Gi=73,m=0;Q0hJTERfQVBDX1BBWUxPQUQ=${ST}`;

interface CapturedApc {
  packet: string;
  controls: string;
  payload: string;
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function extractKittyApcs(transcript: string): { packets: CapturedApc[]; withoutApcs: string } {
  const packets: CapturedApc[] = [];
  let withoutApcs = "";
  let offset = 0;
  while (offset < transcript.length) {
    const start = transcript.indexOf(`${ESC}_G`, offset);
    if (start < 0) {
      withoutApcs += transcript.slice(offset);
      break;
    }
    withoutApcs += transcript.slice(offset, start);
    const end = transcript.indexOf(ST, start + 3);
    expect(end, `unterminated Kitty APC at transcript offset ${start}`).toBeGreaterThanOrEqual(0);
    const packet = transcript.slice(start, end + ST.length);
    const body = packet.slice(3, -ST.length);
    const separator = body.indexOf(";");
    packets.push({
      packet,
      controls: separator < 0 ? body : body.slice(0, separator),
      payload: separator < 0 ? "" : body.slice(separator + 1)
    });
    offset = end + ST.length;
  }
  return { packets, withoutApcs };
}

function controlValue(controls: string, name: string): string | undefined {
  return controls.split(",").find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("runProxy pseudo-terminal integration", () => {
  it("quarantines startup probe replies that arrive after the Agent starts", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const fixture = join(process.cwd(), "test", "fixtures", "proxy-edge-agent.mjs");
    const environment = {
      ...process.env,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      TFORMULA_EDGE_MODE: "late-startup"
    } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;
    let transcript = "";
    let answered = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", "--", process.execPath, fixture], {
      name: "xterm-ghostty",
      cols: 100,
      rows: 32,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("late startup probe fixture timed out"));
      }, 5_000);
      terminal.onData((data) => {
        transcript += data;
        if (!answered && transcript.includes(`${ESC}[16t`)) {
          answered = true;
          setTimeout(() => terminal.write(
            `${ESC}[6;18;9t${ESC}[4;576;900t`
            + `${ESC}]10;rgb:dddd/eeee/ffff${ST}`
            + `${ESC}]11;rgb:1111/2222/3333${ST}`
            + `${ESC}[?62;4;6;22c${ESC}_Gi=2000000000;OK${ST}`
          ), 250);
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    await expect(exited).resolves.toBe(0);
    expect(transcript).toContain("TFORMULA_EDGE_END");
    expect(transcript).not.toContain("TFORMULA_UNEXPECTED_CHILD_INPUT");
    expect(transcript).toContain("a=p");
  }, 6_000);

  it("cancels a suspended resize probe before waiting for child-exit output", async () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const fixture = join(process.cwd(), "test", "fixtures", "proxy-edge-agent.mjs");
    const environment = {
      ...process.env,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      TFORMULA_EDGE_MODE: "exit-during-probe"
    } as Record<string, string>;
    delete environment.TFORMULA_ACTIVE;
    let transcript = "";
    let startupAnswered = false;
    let resized = false;
    const terminal = pty.spawn(tsx, ["src/cli.ts", "--", process.execPath, fixture], {
      name: "xterm-ghostty",
      cols: 100,
      rows: 32,
      cwd: process.cwd(),
      env: environment
    });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("exit during resize probe deadlocked"));
      }, 5_000);
      terminal.onData((data) => {
        transcript += data;
        if (!startupAnswered && transcript.includes(`${ESC}[16t`)) {
          startupAnswered = true;
          terminal.write(
            `${ESC}[6;18;9t${ESC}[4;576;900t`
            + `${ESC}]10;rgb:dddd/eeee/ffff${ST}`
            + `${ESC}]11;rgb:1111/2222/3333${ST}`
            + `${ESC}[?62;4;6;22c${ESC}_Gi=2000000000;OK${ST}`
          );
        }
        if (!resized && transcript.includes("TFORMULA_EDGE_READY:exit-during-probe")) {
          resized = true;
          terminal.resize(73, 21);
          setTimeout(() => terminal.resize(121, 37), 5);
          // Deliberately do not answer either runtime probe.
        }
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });

    await expect(exited).resolves.toBe(0);
    expect(transcript).toContain("TFORMULA_EDGE_END");
    expect(transcript).not.toContain("TFORMULA_UNEXPECTED_CHILD_INPUT");
  }, 6_000);

  it.each([
    { transport: "local Ghostty transport", remote: false, delayedRuntimeProbe: true },
    { transport: "direct PNG transport", remote: true, delayedRuntimeProbe: false }
  ])("keeps Agent controls and Kitty image packets intact with $transport", async ({
    remote,
    delayedRuntimeProbe
  }) => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "tformula-proxy-e2e-cache-"));
    temporaryRoots.push(cacheRoot);
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const fixture = join(process.cwd(), "test", "fixtures", "proxy-agent.mjs");
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    Object.assign(environment, {
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      COLORTERM: "truecolor",
      TFORMULA_CACHE_DIR: cacheRoot,
      FORCE_COLOR: "0"
    });
    for (const name of [
      "TFORMULA_ACTIVE",
      "TMUX",
      "STY",
      "ZELLIJ",
      "MOSH_CONNECTION",
      "SSH_CONNECTION",
      "SSH_CLIENT",
      "SSH_TTY"
    ]) delete environment[name];
    // A remote Ghostty still answers the Kitty query, but cannot open a path
    // on the local filesystem. This forces the bounded direct-PNG path whose
    // payload caused the original visible-Base64 failure.
    if (remote) environment.SSH_CONNECTION = "client 12345 server 22";

    let columns = 100;
    let rows = 32;
    let transcript = "";
    let transcriptBeforeResize = "";
    let resized = false;
    let exited = false;
    let apcScanOffset = 0;
    let activeUploadImageId: string | undefined;
    let graphicsRequestsNeedingResponse = 0;
    let graphicsResponsesWritten = 0;
    let injectedUploadFailure = false;
    let injectedPlacementFailure = false;
    let delayedRuntimeAck = false;
    const answered = new Map<string, number>();
    const terminal = pty.spawn(tsx, [
      "src/cli.ts",
      "--",
      process.execPath,
      fixture
    ], {
      name: "xterm-ghostty",
      cols: columns,
      rows,
      cwd: process.cwd(),
      env: environment
    });

    const replyToNewOccurrences = (
      needle: string,
      response: () => string,
      delayForOccurrence: (index: number) => number = () => 2
    ): void => {
      const seen = occurrences(transcript, needle);
      const previous = answered.get(needle) ?? 0;
      for (let index = previous; index < seen; index += 1) {
        // Let runProxy's writer callback arm its runtime probe before the fake
        // terminal delivers the response on the opposite side of the PTY.
        setTimeout(() => {
          if (!exited) terminal.write(response());
        }, delayForOccurrence(index));
      }
      answered.set(needle, seen);
    };

    const writeTerminalResponse = (
      response: string,
      graphicsRequest = false,
      delayMs = 2
    ): void => {
      setTimeout(() => {
        if (!exited) {
          terminal.write(response);
          if (graphicsRequest) graphicsResponsesWritten += 1;
        }
      }, delayMs);
    };

    const answerCompletedKittyCommands = (): void => {
      let searchFrom = apcScanOffset;
      while (searchFrom < transcript.length) {
        const start = transcript.indexOf(`${ESC}_G`, searchFrom);
        if (start < 0) {
          // Retain enough look-behind to recognize an introducer split across
          // two outer-PTY onData callbacks.
          apcScanOffset = Math.max(searchFrom, transcript.length - 2);
          return;
        }
        const end = transcript.indexOf(ST, start + 3);
        if (end < 0) {
          apcScanOffset = start;
          return;
        }
        const body = transcript.slice(start + 3, end);
        const separator = body.indexOf(";");
        const controls = separator < 0 ? body : body.slice(0, separator);
        const action = controlValue(controls, "a");
        const imageId = controlValue(controls, "i");
        const quiet = controlValue(controls, "q");
        const more = controlValue(controls, "m");

        if (action === "q" && imageId) {
          const numericImageId = Number(imageId);
          const delayMs = delayedRuntimeProbe
            && isRuntimeProbeQueryId(numericImageId)
            && !delayedRuntimeAck
            ? 220
            : 2;
          if (delayMs > 2) delayedRuntimeAck = true;
          writeTerminalResponse(`${ESC}_Gi=${imageId};OK${ST}`, false, delayMs);
        } else if (action === "t" || action === "T") {
          activeUploadImageId = imageId;
          if (quiet === "0" && imageId) {
            graphicsRequestsNeedingResponse += 1;
            const temporaryFile = controlValue(controls, "t") === "t";
            if (!remote && process.platform === "darwin" && temporaryFile
              && !injectedUploadFailure) {
              injectedUploadFailure = true;
              writeTerminalResponse(
                `${ESC}_Gi=${imageId};EINVAL: temporary file rejected${ST}`,
                true
              );
            } else {
              writeTerminalResponse(`${ESC}_Gi=${imageId};OK${ST}`, true);
            }
            activeUploadImageId = undefined;
          }
        } else if (!action && quiet === "0" && more === "0" && activeUploadImageId) {
          graphicsRequestsNeedingResponse += 1;
          writeTerminalResponse(`${ESC}_Gi=${activeUploadImageId};OK${ST}`, true);
          activeUploadImageId = undefined;
        } else if (action === "p" && quiet === "0" && imageId) {
          const placementId = controlValue(controls, "p");
          graphicsRequestsNeedingResponse += 1;
          if (remote && !injectedPlacementFailure) {
            injectedPlacementFailure = true;
            writeTerminalResponse(
              `${ESC}_Gi=${imageId}${placementId ? `,p=${placementId}` : ""};ENOENT: image evicted${ST}`,
              true
            );
          } else {
            writeTerminalResponse(
              `${ESC}_Gi=${imageId}${placementId ? `,p=${placementId}` : ""};OK${ST}`,
              true
            );
          }
        }
        searchFrom = end + ST.length;
        apcScanOffset = searchFrom;
      }
    };

    const exit = new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminal.kill();
        reject(new Error("TFormula PTY integration fixture timed out"));
      }, 30_000);

      terminal.onData((data) => {
        transcript += data;
        const runtimeDelay = (index: number): number =>
          delayedRuntimeProbe && index === 1 ? 220 : 2;
        replyToNewOccurrences(`${ESC}[16t`, () => `${ESC}[6;18;9t`, runtimeDelay);
        replyToNewOccurrences(
          `${ESC}[14t`,
          () => `${ESC}[4;${rows * 18};${columns * 9}t`,
          runtimeDelay
        );
        replyToNewOccurrences(
          `${ESC}]10;?${ST}`,
          () => `${ESC}]10;rgb:dddd/eeee/ffff${ST}`,
          runtimeDelay
        );
        replyToNewOccurrences(
          `${ESC}]11;?${ST}`,
          () => `${ESC}]11;rgb:1111/2222/3333${ST}`,
          runtimeDelay
        );
        replyToNewOccurrences(`${ESC}[c`, () => `${ESC}[?62;4;6;22c`);
        answerCompletedKittyCommands();

        if (!resized && transcript.includes("TFORMULA_FIXTURE_READY")) {
          resized = true;
          transcriptBeforeResize = transcript.slice(
            0,
            transcript.indexOf("TFORMULA_FIXTURE_READY") + "TFORMULA_FIXTURE_READY".length
          );
          const geometries = [
            [72, 20],
            [128, 38],
            [78, 22],
            [116, 35],
            [68, 19],
            [132, 40],
            [74, 21],
            [120, 36],
            [82, 24],
            [100, 32]
          ] as const;
          geometries.forEach(([nextColumns, nextRows], index) => {
            setTimeout(() => {
              if (exited) return;
              columns = nextColumns;
              rows = nextRows;
              terminal.resize(columns, rows);
            }, index * 12);
          });
        }
      });
      terminal.onExit((event) => {
        exited = true;
        clearTimeout(timeout);
        // node-pty delivers all bytes before onExit on supported platforms,
        // but one event-loop turn also protects against an adapter regression.
        setImmediate(() => resolve(event));
      });
    });

    const result = await exit;
    expect(result.exitCode).toBe(0);
    expect(transcript).toContain("TFORMULA_FIXTURE_BEGIN");
    expect(transcript).toContain("TFORMULA_FIXTURE_READY");
    expect(transcript).toContain("TFORMULA_FIXTURE_END");
    expect(transcript).not.toContain("TFORMULA_UNEXPECTED_CHILD_INPUT");
    expect(graphicsRequestsNeedingResponse).toBeGreaterThan(0);
    expect(graphicsResponsesWritten).toBe(graphicsRequestsNeedingResponse);
    if (remote) expect(injectedPlacementFailure).toBe(true);
    if (!remote && process.platform === "darwin") expect(injectedUploadFailure).toBe(true);
    expect(delayedRuntimeAck).toBe(delayedRuntimeProbe);
    expect(transcript).toContain(`LONG_NO_LF_BEGIN:${"x".repeat(1_600)}:LONG_NO_LF_END`);

    // If TFormula inserts an image between two callbacks of either control,
    // the original byte sequence will no longer occur contiguously here.
    expect(transcript).toContain(CHILD_OSC);
    expect(transcript).toContain(CHILD_APC);

    const { packets, withoutApcs } = extractKittyApcs(transcript);
    expect(packets.length).toBeGreaterThan(4);
    expect(withoutApcs).not.toContain(`${ESC}_G`);
    // A direct PNG transfer is allowed, but its Base64 must never escape its
    // terminated APC and become visible terminal text.
    const ordinaryOutput = withoutApcs
      // The wrapped Agent intentionally emits both of these strings. They are
      // control-integrity sentinels, not leaked TFormula image data.
      .replace(CHILD_OSC, "")
      .replace("x".repeat(1_600), "");
    expect(ordinaryOutput).not.toContain("iVBORw0KGgo");
    expect(ordinaryOutput).not.toMatch(/[A-Za-z0-9+/]{512,}={0,2}/u);

    const uploads = packets.filter(({ controls }) => controlValue(controls, "a") === "t");
    const placements = packets.filter(({ controls }) => controlValue(controls, "a") === "p");
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    expect(placements.length).toBeGreaterThanOrEqual(3);

    const uploadedIds = new Set(uploads.map(({ controls }) => controlValue(controls, "i")));
    expect(uploadedIds.size).toBeGreaterThanOrEqual(
      remote || (!remote && process.platform === "darwin") ? 3 : 2
    );
    const directTransmission = remote || process.platform !== "darwin";
    if (directTransmission) {
      expect(uploads.every(({ controls }) => controlValue(controls, "t") === "d")).toBe(true);
      expect(uploads.every(({ payload }) => payload.startsWith("iVBORw0KGgo"))).toBe(true);
    } else {
      // The first path upload is deliberately rejected; the same process must
      // recover by sending a bounded direct PNG rather than exposing Base64.
      expect(controlValue(uploads[0]!.controls, "t")).toBe("t");
      expect(uploads.some(({ controls }) => controlValue(controls, "t") === "d")).toBe(true);
    }
    for (const placement of placements) {
      expect(uploadedIds.has(controlValue(placement.controls, "i"))).toBe(true);
    }
    // The first two source formulas are identical. They should share one
    // terminal image even though each location has its own placement id.
    const initialPlacements = extractKittyApcs(transcriptBeforeResize).packets
      .filter(({ controls }) => controlValue(controls, "a") === "p");
    expect(initialPlacements.length).toBeGreaterThanOrEqual(2);
    const placementsByImage = new Map<string, Set<string>>();
    for (const placement of initialPlacements) {
      const imageId = controlValue(placement.controls, "i") ?? "";
      const placementId = controlValue(placement.controls, "p") ?? "";
      const ids = placementsByImage.get(imageId) ?? new Set<string>();
      ids.add(placementId);
      placementsByImage.set(imageId, ids);
    }
    expect([...placementsByImage.values()].some((ids) => ids.size >= 2)).toBe(true);

    // Startup plus the resize storm must have exercised more than one live
    // cell/window probe rather than only the one-shot capability path.
    expect(occurrences(transcript, `${ESC}[16t`)).toBeGreaterThan(1);
    expect(occurrences(transcript, `${ESC}[14t`)).toBeGreaterThan(1);
    expect(transcript).not.toContain("tformula: terminal output failed");
  }, 35_000);
});
