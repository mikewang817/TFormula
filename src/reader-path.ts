import { extname } from "node:path";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const TEXT_EXTENSIONS = new Set([".txt", ".text", ".log", ".out"]);
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
const JSON_EXTENSIONS = new Set([".json"]);
const JSON_LINES_EXTENSIONS = new Set([".jsonl", ".ndjson"]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const TOML_EXTENSIONS = new Set([".toml"]);
const XML_EXTENSIONS = new Set([".xml"]);
const CSV_EXTENSIONS = new Set([".csv"]);
const TSV_EXTENSIONS = new Set([".tsv"]);
const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);
const EPUB_EXTENSIONS = new Set([".epub"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tgz", ".gz"]);
const BINARY_EXTENSIONS = new Set([".bin"]);

export type ReaderFileKind =
  | "markdown"
  | "text"
  | "image"
  | "json"
  | "jsonl"
  | "yaml"
  | "toml"
  | "xml"
  | "csv"
  | "tsv"
  | "html"
  | "notebook"
  | "epub"
  | "pdf"
  | "archive"
  | "binary";

export function readerFileKind(path: string): ReaderFileKind | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tar.gz")) return "archive";
  const extension = extname(path).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (JSON_EXTENSIONS.has(extension)) return "json";
  if (JSON_LINES_EXTENSIONS.has(extension)) return "jsonl";
  if (YAML_EXTENSIONS.has(extension)) return "yaml";
  if (TOML_EXTENSIONS.has(extension)) return "toml";
  if (XML_EXTENSIONS.has(extension)) return "xml";
  if (CSV_EXTENSIONS.has(extension)) return "csv";
  if (TSV_EXTENSIONS.has(extension)) return "tsv";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (NOTEBOOK_EXTENSIONS.has(extension)) return "notebook";
  if (EPUB_EXTENSIONS.has(extension)) return "epub";
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (BINARY_EXTENSIONS.has(extension)) return "binary";
  return undefined;
}

export function looksLikeReaderPath(path: string): boolean {
  return readerFileKind(path) !== undefined;
}
