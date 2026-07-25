import { planFormulaPlacements } from "../src/formula-layout.js";
import {
  detectScreenFormulaRegions as detectMappedScreenFormulas,
  type PhysicalScreenLine
} from "../src/screen-text.js";
import type {
  FormulaCanvasMode,
  FormulaPlacementPlan,
  FormulaWrapSegment,
  MappedFormula
} from "../src/types.js";

interface LegacyTestRegion {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  latex: string;
  intent: MappedFormula["formula"]["intent"];
  display: boolean;
  confidence: MappedFormula["formula"]["confidence"];
  standalone?: boolean;
  compact?: boolean;
  composite?: boolean;
  displayRange?: { startCol: number; endCol: number };
  sourceSegments?: FormulaWrapSegment[];
  wrapSegments?: FormulaWrapSegment[];
  canvasMode?: FormulaCanvasMode;
  estimatedQuality?: number;
}

function legacyMappedRegion(mapped: MappedFormula, columns: number): LegacyTestRegion {
  const display = mapped.formula.intent !== "inline";
  const wrappedSegments = mapped.fullWidth && mapped.formula.intent !== "display"
    ? mapped.formulaSlices.length > 0 ? mapped.formulaSlices : mapped.sourceSegments
    : undefined;
  return {
    startRow: mapped.source.startRow,
    endRow: mapped.source.endRow,
    startCol: mapped.fullWidth ? 0 : mapped.source.startCol,
    endCol: mapped.fullWidth ? columns : mapped.source.endCol,
    latex: mapped.formula.latex,
    intent: mapped.formula.intent,
    display,
    confidence: mapped.formula.confidence,
    ...(mapped.formula.intent === "display" ? { standalone: true } : {}),
    ...(mapped.formula.compact ? { compact: true } : {}),
    ...(mapped.composite ? { composite: true } : {}),
    ...(mapped.displayRange ? { displayRange: mapped.displayRange } : {}),
    ...(mapped.formula.intent === "display"
      ? { sourceSegments: mapped.sourceSegments }
      : wrappedSegments?.length ? { wrapSegments: wrappedSegments } : {})
  };
}

function legacyPlannedRegion(plan: FormulaPlacementPlan): LegacyTestRegion {
  const display = plan.formula.intent !== "inline";
  const displayRange = plan.displayRange && {
    startCol: plan.canvas.startCol + plan.displayRange.startCol,
    endCol: plan.canvas.startCol + plan.displayRange.endCol
  };
  const usesIndependentMasks = plan.formula.intent === "display"
    || (plan.formula.intent === "inline" && plan.mode.startsWith("borrowed"));
  return {
    startRow: plan.canvas.startRow,
    endRow: plan.canvas.endRow,
    startCol: plan.canvas.startCol,
    endCol: plan.canvas.endCol,
    latex: plan.formula.latex,
    intent: plan.formula.intent,
    display,
    confidence: plan.formula.confidence,
    ...(plan.formula.intent === "display" ? { standalone: true } : {}),
    ...(plan.formula.compact ? { compact: true } : {}),
    ...(plan.composite ? { composite: true } : {}),
    ...(displayRange ? { displayRange } : {}),
    ...(usesIndependentMasks
      ? { sourceSegments: plan.sourceMasks }
      : plan.sourceMasks.length ? { wrapSegments: plan.sourceMasks } : {}),
    ...(["source", "borrowed-above", "borrowed-below", "borrowed-both"].includes(plan.mode)
      && (plan.formula.intent === "display"
        || (plan.formula.intent === "inline" && plan.formula.compact))
      ? { canvasMode: plan.mode, estimatedQuality: plan.estimatedQuality }
      : {})
  };
}

/** Test-only projection for assertions written before MappedFormula. */
export function detectScreenFormulaRegions(
  lines: PhysicalScreenLine[],
  columns: number,
  continuesAfterViewport = false
) {
  const snapshot = detectMappedScreenFormulas(lines, columns, continuesAfterViewport);
  return {
    ...snapshot,
    regions: snapshot.formulas.map((mapped) => legacyMappedRegion(mapped, columns))
  };
}

/** Test-only projection for old flattened placement assertions. */
export function detectAndPlan(lines: PhysicalScreenLine[], columns: number) {
  const snapshot = detectMappedScreenFormulas(lines, columns);
  const plans = planFormulaPlacements(snapshot.formulas, lines, columns);
  return {
    ...snapshot,
    plans,
    regions: plans.map(legacyPlannedRegion)
  };
}
