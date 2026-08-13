import { renderAsync } from "@resvg/resvg-js";

interface RasterRequest {
  id: number;
  svg: string;
  loadSystemFonts: boolean;
  fontFiles?: string[];
  maxDimension: number;
  maxPngBytes: number;
}

interface RasterSuccess {
  id: number;
  ok: true;
  png: Buffer;
}

interface RasterFailure {
  id: number;
  ok: false;
  code: "raster-limit" | "empty-raster" | "png-limit" | "raster-error";
  message: string;
}

function hasVisiblePixel(pixels: Buffer): boolean {
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] !== 0) return true;
  }
  return false;
}

function send(message: RasterSuccess | RasterFailure): void {
  if (process.connected) process.send?.(message);
}

process.on("message", async (message: RasterRequest) => {
  if (!message || !Number.isSafeInteger(message.id) || typeof message.svg !== "string") return;
  try {
    const rendered = await renderAsync(message.svg, {
      fitTo: { mode: "original" },
      font: {
        loadSystemFonts: message.loadSystemFonts,
        ...(message.fontFiles ? { fontFiles: message.fontFiles } : {})
      },
      shapeRendering: 2,
      textRendering: 2,
      logLevel: "error"
    });
    if (rendered.width < 1 || rendered.height < 1
      || rendered.width > message.maxDimension || rendered.height > message.maxDimension) {
      send({
        id: message.id,
        ok: false,
        code: "raster-limit",
        message: `formula raster exceeds ${message.maxDimension}x${message.maxDimension} pixels`
      });
      return;
    }
    if (!hasVisiblePixel(rendered.pixels)) {
      send({
        id: message.id,
        ok: false,
        code: "empty-raster",
        message: "formula raster contains no visible pixels"
      });
      return;
    }
    const png = rendered.asPng();
    if (png.byteLength > message.maxPngBytes) {
      send({
        id: message.id,
        ok: false,
        code: "png-limit",
        message: `formula PNG exceeds ${message.maxPngBytes} bytes`
      });
      return;
    }
    send({ id: message.id, ok: true, png });
  } catch (error) {
    send({
      id: message.id,
      ok: false,
      code: "raster-error",
      message: `formula rasterization failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }
});

process.on("disconnect", () => process.exit(0));
