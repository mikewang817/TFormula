import { extname } from "node:path";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const TEXT_EXTENSIONS = new Set([".txt", ".text"]);
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp"
]);

export type ReaderFileKind = "markdown" | "text" | "image";

export function readerFileKind(path: string): ReaderFileKind | undefined {
  const extension = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return undefined;
}

export function looksLikeReaderPath(path: string): boolean {
  return readerFileKind(path) !== undefined;
}
