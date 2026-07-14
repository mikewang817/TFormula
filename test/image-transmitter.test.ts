import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isGhosttyTerminal,
  KittyImageTransmitter,
  selectImageTransmissionMode
} from "../src/image-transmitter.js";

describe("Kitty image transmission selection", () => {
  it("identifies Ghostty without treating other Kitty terminals as Ghostty", () => {
    expect(isGhosttyTerminal({ TERM: "xterm-ghostty" })).toBe(true);
    expect(isGhosttyTerminal({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(isGhosttyTerminal({ TERM: "xterm-kitty", TERM_PROGRAM: "kitty" })).toBe(false);
    expect(isGhosttyTerminal({ TERM_PROGRAM: "WezTerm" })).toBe(false);
  });

  it("uses temporary files only for a local macOS Ghostty", () => {
    expect(selectImageTransmissionMode({ TERM: "xterm-ghostty" }, "darwin")).toBe("temp-file");
    expect(selectImageTransmissionMode({ TERM_PROGRAM: "ghostty" }, "darwin")).toBe("temp-file");
    expect(selectImageTransmissionMode({ TERM: "xterm-ghostty", SSH_CONNECTION: "remote" }, "darwin"))
      .toBe("direct");
    expect(selectImageTransmissionMode({ TERM: "xterm-ghostty" }, "linux")).toBe("direct");
    expect(selectImageTransmissionMode({ TERM: "xterm-kitty" }, "darwin")).toBe("direct");
  });

  it("creates a private PNG and removes leftovers on disposal", async () => {
    const transmitter = new KittyImageTransmitter("temp-file");
    const png = Uint8Array.from([137, 80, 78, 71]);
    const command = transmitter.transmit(png, 42);
    const encodedPath = command.match(/;([A-Za-z0-9+/=]+)\x1b\\$/u)?.[1] ?? "";
    const path = Buffer.from(encodedPath, "base64").toString("utf8");

    expect(path).toContain("tty-graphics-protocol");
    expect(readFileSync(path)).toEqual(Buffer.from(png));
    expect(command).toContain("q=0");
    expect(transmitter.wasTemporaryFileImage(42)).toBe(true);
    transmitter.markImageAccepted(42);
    expect(transmitter.wasTemporaryFileImage(42)).toBe(false);
    await transmitter.dispose(0);
    expect(existsSync(path)).toBe(false);
  });

  it("can fall back to bounded direct packets after a path-transport error", async () => {
    const transmitter = new KittyImageTransmitter("temp-file");
    transmitter.transmit(new Uint8Array([1]), 41);
    transmitter.transmit(new Uint8Array([2]), 42);
    expect(transmitter.wasTemporaryFileImage(41)).toBe(true);
    expect(transmitter.wasTemporaryFileImage(42)).toBe(true);
    expect(transmitter.fallbackToDirect()).toBe(true);
    expect(transmitter.mode).toBe("direct");
    expect(transmitter.transmit(new Uint8Array([137, 80, 78, 71]), 42))
      .toContain("a=t,f=100,t=d");
    // Once direct mode is global, late path-upload failures are handled as
    // ordinary image errors and no per-id temporary state is retained.
    expect(transmitter.wasTemporaryFileImage(41)).toBe(false);
    expect(transmitter.wasTemporaryFileImage(42)).toBe(false);
    transmitter.markImageAccepted(42);
    expect(transmitter.wasTemporaryFileImage(42)).toBe(false);
    expect(transmitter.wasTemporaryFileImage(41)).toBe(false);
    expect(transmitter.fallbackToDirect()).toBe(false);
    await transmitter.dispose(0);
  });

  it("finishes teardown if the temporary directory was removed externally", async () => {
    const transmitter = new KittyImageTransmitter("temp-file");
    const command = transmitter.transmit(new Uint8Array([1, 2, 3]), 43);
    const encodedPath = command.match(/;([A-Za-z0-9+/=]+)\x1b\\$/u)?.[1] ?? "";
    const path = Buffer.from(encodedPath, "base64").toString("utf8");
    rmSync(dirname(path), { force: true, recursive: true });

    await expect(transmitter.dispose(10)).resolves.toBeUndefined();
    expect(transmitter.wasTemporaryFileImage(43)).toBe(false);
  });

  it("recreates a temporary directory removed during a long-running session", async () => {
    const transmitter = new KittyImageTransmitter("temp-file");
    const first = transmitter.transmit(new Uint8Array([1]), 44);
    const firstPayload = first.match(/;([A-Za-z0-9+/=]+)\x1b\\$/u)?.[1] ?? "";
    const firstPath = Buffer.from(firstPayload, "base64").toString("utf8");
    rmSync(dirname(firstPath), { force: true, recursive: true });

    const png = new Uint8Array([2, 3, 4]);
    const second = transmitter.transmit(png, 45);
    const secondPayload = second.match(/;([A-Za-z0-9+/=]+)\x1b\\$/u)?.[1] ?? "";
    const secondPath = Buffer.from(secondPayload, "base64").toString("utf8");
    expect(dirname(secondPath)).not.toBe(dirname(firstPath));
    expect(readFileSync(secondPath)).toEqual(Buffer.from(png));

    await transmitter.dispose(0);
  });
});
