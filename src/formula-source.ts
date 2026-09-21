import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import stringWidth from "string-width";
import { parseMarkdown } from "./reader-document.js";
import type { DetectedFormula } from "./types.js";

function textContent(node: Nodes): string {
  if ("value" in node) return node.value;
  if (node.type === "break") return "\n";
  return "children" in node ? node.children.map(textContent).join("") : "";
}

/** Project source through CommonMark, without interpreting the result as TeX. */
export function terminalMarkdownProjection(markdown: string): string {
  return fromMarkdown(markdown).children.map((node) =>
    (node.type === "heading" ? `${"#".repeat(node.depth)} ` : "") + textContent(node)
  ).join("\n\n");
}

function key(text: string): string {
  // TUI gutters, blank rows and soft/hard wrapping are presentational. Never
  // discard mathematical punctuation, subscripts or commands when matching.
  return text.replace(/^\s*[│┃>]\s?/gmu, "").replace(/\s+/gu, "");
}

export interface FormulaSourceResolution {
  formulas: DetectedFormula[];
  /** Damaged/incomplete blocks must not fall through to fragment inference. */
  ownedRows: Set<number>;
}

/** Exact, ambiguity-rejecting lookup of terminal projections to authored TeX. */
export class FormulaSource {
  readonly #entries = new Map<string, Set<string>>();
  readonly #sources = new Set<string>();
  readonly #maxFormulas: number;

  constructor(maxFormulas = 4096) { this.#maxFormulas = maxFormulas; }

  get size(): number { return this.#sources.size; }

  clear(): void { this.#entries.clear(); this.#sources.clear(); }

  addMarkdown(markdown: string): boolean {
    let changed = false;
    const visit = (node: Nodes): void => {
      if (node.type === "math") {
        const latex = node.value.trim();
        if (!latex || latex.length > 20_000 || this.#sources.has(latex)
          || this.#sources.size >= this.#maxFormulas) return;
        this.#sources.add(latex);
        for (const source of [`\\[\n${latex}\n\\]`, `$$\n${latex}\n$$`]) {
          for (const variant of [source, terminalMarkdownProjection(source)]) {
            const id = key(variant);
            const candidates = this.#entries.get(id) ?? new Set<string>();
            candidates.add(latex);
            this.#entries.set(id, candidates);
          }
        }
        changed = true;
      } else if ("children" in node) node.children.forEach(visit);
    };
    visit(parseMarkdown(markdown));
    return changed;
  }

  resolve(lines: string[]): FormulaSourceResolution {
    const formulas: DetectedFormula[] = [];
    const ownedRows = new Set<number>();
    let fence: string | undefined;
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row]!;
      const marker = line.trim().match(/^(`{3,}|~{3,})/u)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        continue;
      }
      if (fence) continue;
      const opening = line.match(/^(\s*(?:[│┃>]\s*)*)(#{1,6}\s+)?(\\\[|\[|\$\$)(.*)$/u);
      if (!opening) continue;
      const prefix = opening[1]!;
      const token = opening[3]!;
      const remainder = opening[4]!.trim();
      if (remainder) {
        const closes = token === "$$" ? remainder.endsWith("$$") : remainder.endsWith("]");
        if (closes) {
          const candidates = this.#entries.get(key(line.slice(prefix.length)));
          if (candidates) ownedRows.add(row);
          if (candidates?.size === 1) formulas.push({
            source: { startRow: row, endRow: row, startCol: stringWidth(prefix), endCol: stringWidth(line) },
            latex: candidates.values().next().value!, intent: "display", confidence: "explicit"
          });
        }
        continue;
      }
      let end = row + 1;
      for (; end < Math.min(lines.length, row + 257); end += 1) {
        const closing = lines[end]!.trim();
        const body = lines[end]!.startsWith(prefix) ? lines[end]!.slice(prefix.length).trim() : closing;
        if (token === "$$" ? body === "$$" : body === "]" || body === "\\]") break;
        // Do not absorb another formula or subsequent prose headings.
        if (/^(?:#{1,6}\s|\\\[\s*$)/u.test(body)) break;
      }
      const last = lines[end]?.trim().replace(/^[│┃>]\s*/u, "");
      const complete = token === "$$" ? last === "$$" : last === "]" || last === "\\]";
      if (!complete) {
        if (opening[2]) for (let i = row; i < end; i += 1) ownedRows.add(i);
        continue;
      }
      const block = lines.slice(row, end + 1).map((s) => s.startsWith(prefix) ? s.slice(prefix.length) : s).join("\n");
      const candidates = this.#entries.get(key(block));
      if (candidates || opening[2]) {
        for (let i = row; i <= end; i += 1) ownedRows.add(i);
      }
      // Multiple originals can have the same Markdown projection (e.g. lost
      // subscripts). Rendering either would silently change the mathematics.
      if (candidates?.size === 1) {
        formulas.push({
          source: { startRow: row, endRow: end, startCol: stringWidth(prefix), endCol: stringWidth(lines[end]!) },
          latex: candidates.values().next().value!, intent: "display", confidence: "explicit"
        });
      }
      row = end;
    }
    return { formulas, ownedRows };
  }
}
