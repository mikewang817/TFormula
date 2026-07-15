export type ScientificFormulaDomain =
  | "mathematics"
  | "physics"
  | "chemistry"
  | "biology"
  | "technical";

export interface ScientificFormulaCase {
  id: string;
  domain: ScientificFormulaDomain;
  feature: string;
  latex: string;
  display?: boolean;
}

export interface ScientificTerminalCase {
  id: string;
  domain: ScientificFormulaDomain;
  lines: string[];
  expectedLatex: string;
  display?: boolean;
}

/**
 * A semantics-first compatibility corpus representing formulas commonly
 * emitted by terminal agents. Every entry should render without rewriting its
 * mathematical meaning. Full-LaTeX graphics belong in the explicit boundary
 * corpus below rather than being approximated here.
 */
export const SCIENTIFIC_FORMULA_CORPUS: ScientificFormulaCase[] = [
  {
    id: "kl-divergence-tag",
    domain: "mathematics",
    feature: "large operators and equation tags",
    latex: "D_{KL}(P\\|Q)=\\sum_{i=1}^{n}P(x_i)\\log\\frac{P(x_i)}{Q(x_i)}\\tag{2}",
    display: true
  },
  {
    id: "aligned-derivation",
    domain: "mathematics",
    feature: "AMS aligned rows",
    latex: "\\begin{aligned}(a+b)^2&=a^2+2ab+b^2\\\\&=a(a+2b)+b^2\\end{aligned}",
    display: true
  },
  {
    id: "display-cases",
    domain: "mathematics",
    feature: "piecewise definitions",
    latex: "f(x)=\\begin{cases}x^2,&x\\ge0\\\\-x,&x<0\\end{cases}",
    display: true
  },
  {
    id: "mathtools-dcases",
    domain: "mathematics",
    feature: "mathtools display cases",
    latex: "f(x)=\\begin{dcases}\\frac{1}{x},&x>0\\\\0,&x\\le0\\end{dcases}",
    display: true
  },
  {
    id: "mathtools-relations",
    domain: "mathematics",
    feature: "semantic relation symbols",
    latex: "f\\colon X\\to Y,\\qquad x\\coloneqq y+1,\\qquad A\\xleftrightarrow{\\phi}B",
    display: true
  },
  {
    id: "mathtools-prescript",
    domain: "mathematics",
    feature: "left scripts",
    latex: "\\prescript{n}{}{P}_{k}=\\frac{n!}{(n-k)!}",
    display: true
  },
  {
    id: "cancelled-factor",
    domain: "mathematics",
    feature: "cancellation annotations",
    latex: "\\frac{\\cancel{x}(x+1)}{\\cancel{x}}=x+1",
    display: true
  },
  {
    id: "centered-negation",
    domain: "mathematics",
    feature: "centered relation negation",
    latex: "A\\centernot\\implies B",
    display: true
  },
  {
    id: "matrix-determinant",
    domain: "mathematics",
    feature: "nested matrices and determinants",
    latex: "\\det\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}=ad-bc",
    display: true
  },
  {
    id: "gaussian-integral",
    domain: "mathematics",
    feature: "improper integrals",
    latex: "\\int_{-\\infty}^{\\infty}e^{-x^2}\\,dx=\\sqrt{\\pi}",
    display: true
  },
  {
    id: "maxwell-ampere",
    domain: "physics",
    feature: "surface and contour integrals",
    latex: "\\oint_C\\mathbf B\\cdot d\\boldsymbol\\ell=\\mu_0I_{\\mathrm{enc}}+\\mu_0\\varepsilon_0\\frac{d}{dt}\\int_S\\mathbf E\\cdot d\\mathbf A",
    display: true
  },
  {
    id: "schrodinger-equation",
    domain: "physics",
    feature: "partial derivatives and operators",
    latex: "i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf r,t)=\\left[-\\frac{\\hbar^2}{2m}\\nabla^2+V(\\mathbf r,t)\\right]\\Psi(\\mathbf r,t)",
    display: true
  },
  {
    id: "physics-derivatives",
    domain: "physics",
    feature: "physics derivative macros",
    latex: "\\dv{}{t}\\left(\\pdv{L}{\\dot q}\\right)-\\pdv{L}{q}=0",
    display: true
  },
  {
    id: "quantum-expectation",
    domain: "physics",
    feature: "Dirac notation",
    latex: "\\expval{\\hat H}{\\psi}=\\mel{\\psi}{\\hat H}{\\psi}",
    display: true
  },
  {
    id: "quantum-commutator",
    domain: "physics",
    feature: "physics commutator macros",
    latex: "\\comm{\\hat x}{\\hat p}=i\\hbar,\\qquad\\acomm{\\gamma^\\mu}{\\gamma^\\nu}=2g^{\\mu\\nu}",
    display: true
  },
  {
    id: "upright-greek",
    domain: "physics",
    feature: "upright Greek symbols",
    latex: "\\upmu=4\\pi\\times10^{-7}\\,\\mathrm{N\\,A^{-2}}",
    display: true
  },
  {
    id: "bold-symbol",
    domain: "physics",
    feature: "bold Greek tensors",
    latex: "\\boldsymbol{\\sigma}\\cdot\\mathbf n=\\mathbf t",
    display: true
  },
  {
    id: "units-extension",
    domain: "physics",
    feature: "numbered physical units",
    latex: "v=\\units[3.00]{m}\\,\\unitfrac{s}{s^2}",
    display: true
  },
  {
    id: "siunitx-common-form",
    domain: "physics",
    feature: "common agent-generated SI syntax",
    latex: "g=\\SI{9.81}{\\metre\\per\\second\\squared}",
    display: true
  },
  {
    id: "siunitx-v3-quantity",
    domain: "physics",
    feature: "unambiguous siunitx v3 quantity syntax",
    latex: "d=\\qty{5.0}{\\micro\\metre}",
    display: true
  },
  {
    id: "siunitx-unit-only",
    domain: "physics",
    feature: "numberless compound SI units",
    latex: "R=8.314\\,\\si{\\joule\\per\\mole\\per\\kelvin}",
    display: true
  },
  {
    id: "chemical-combustion",
    domain: "chemistry",
    feature: "balanced reactions",
    latex: "\\ce{2 CH4 + 4 O2 -> 2 CO2 + 4 H2O}",
    display: true
  },
  {
    id: "chemical-equilibrium",
    domain: "chemistry",
    feature: "ions and equilibrium arrows",
    latex: "\\ce{Fe^{3+} + SCN^- <=> [FeSCN]^{2+}}",
    display: true
  },
  {
    id: "chemical-isotope",
    domain: "chemistry",
    feature: "isotope scripts",
    latex: "\\ce{^{14}_{6}C -> ^{14}_{7}N + e^- + \\bar{\\nu}_e}",
    display: true
  },
  {
    id: "chemical-conditions",
    domain: "chemistry",
    feature: "reaction conditions",
    latex: "\\ce{N2 + 3 H2 ->[Fe, 450 ^\\circ C][200 atm] 2 NH3}",
    display: true
  },
  {
    id: "chemical-bonds",
    domain: "chemistry",
    feature: "structural bond notation",
    latex: "\\ce{CH3-CH2-OH + O2 -> CH3-COOH + H2O}",
    display: true
  },
  {
    id: "chemical-concentration",
    domain: "chemistry",
    feature: "mhchem physical units",
    latex: "c=\\pu{1.20e-3 mol L-1}",
    display: true
  },
  {
    id: "chemical-gibbs",
    domain: "chemistry",
    feature: "thermodynamic annotations",
    latex: "\\Delta G^\\circ=-RT\\ln K,\\qquad\\ce{A <=> B}",
    display: true
  },
  {
    id: "chemical-degree-symbols",
    domain: "chemistry",
    feature: "scientific unit symbols",
    latex: "T=25\\,\\celsius,\\qquad R=8.314\\,\\mathrm{J\\,mol^{-1}\\,K^{-1}}",
    display: true
  },
  {
    id: "chemical-si-pressure",
    domain: "chemistry",
    feature: "SI prefixes and derived units",
    latex: "P=\\SI{101.3}{\\kilo\\pascal},\\qquad T=\\SI{25}{\\degreeCelsius}",
    display: true
  },
  {
    id: "michaelis-menten",
    domain: "biology",
    feature: "enzyme kinetics",
    latex: "v=\\frac{V_{\\max}[S]}{K_m+[S]}",
    display: true
  },
  {
    id: "hill-equation",
    domain: "biology",
    feature: "cooperative binding",
    latex: "\\theta=\\frac{[L]^n}{K_d+[L]^n}",
    display: true
  },
  {
    id: "hardy-weinberg",
    domain: "biology",
    feature: "population genetics",
    latex: "p^2+2pq+q^2=1,\\qquad p+q=1",
    display: true
  },
  {
    id: "logistic-growth",
    domain: "biology",
    feature: "population dynamics",
    latex: "\\dv{N}{t}=rN\\left(1-\\frac{N}{K}\\right)",
    display: true
  },
  {
    id: "lotka-volterra",
    domain: "biology",
    feature: "coupled differential equations",
    latex: "\\begin{aligned}\\dv{x}{t}&=\\alpha x-\\beta xy\\\\\\dv{y}{t}&=\\delta xy-\\gamma y\\end{aligned}",
    display: true
  },
  {
    id: "nernst-equation",
    domain: "biology",
    feature: "electrochemical potentials",
    latex: "E=E^\\circ-\\frac{RT}{zF}\\ln\\frac{[\\mathrm{Red}]}{[\\mathrm{Ox}]}",
    display: true
  },
  {
    id: "dna-direction",
    domain: "biology",
    feature: "sequence direction labels",
    latex: "5^{\\prime}\\text{-}\\mathrm{ATGCGT}\\text{-}3^{\\prime}",
    display: true
  },
  {
    id: "radioisotope-tracer",
    domain: "biology",
    feature: "left isotope scripts",
    latex: "\\prescript{32}{}{P}\\text{-labelled DNA}",
    display: true
  },
  {
    id: "photosynthesis",
    domain: "biology",
    feature: "biochemical reactions",
    latex: "\\ce{6 CO2 + 6 H2O ->[h\\nu] C6H12O6 + 6 O2}",
    display: true
  },
  {
    id: "confidence-interval",
    domain: "biology",
    feature: "biostatistics",
    latex: "\\hat p\\pm z_{\\alpha/2}\\sqrt{\\frac{\\hat p(1-\\hat p)}{n}}",
    display: true
  },
  {
    id: "biological-molar-flux",
    domain: "biology",
    feature: "prefixed compound biological units",
    latex: "J=\\SI{12.5}{\\micro\\mole\\per\\metre\\squared\\per\\second}",
    display: true
  },
  {
    id: "circled-relation",
    domain: "technical",
    feature: "LaTeX compatibility rewrite",
    latex: "x^{(\\text{\\textcircled{=}})}y"
  },
  {
    id: "multilingual-text",
    domain: "technical",
    feature: "CJK text inside mathematics",
    latex: "\\text{速度 }v=3.0\\times10^8\\,\\mathrm{m\\,s^{-1}}",
    display: true
  },
  {
    id: "definition-annotation",
    domain: "technical",
    feature: "stacked textual annotations",
    latex: "f(x)\\overset{\\mathrm{def}}{=}\\int_{-\\infty}^{x}p(t)\\,dt",
    display: true
  },
  {
    id: "long-reaction-arrow",
    domain: "technical",
    feature: "extensible arrows",
    latex: "A\\xlongequal{\\text{catalyst}}B",
    display: true
  },
  {
    id: "numbered-system",
    domain: "technical",
    feature: "numbered cases",
    latex: "\\begin{numcases}{|x|=}x,&if $x\\ge0$\\\\-x,&if $x<0$\\end{numcases}",
    display: true
  }
];

export const FULL_LATEX_BOUNDARY_CORPUS: ScientificFormulaCase[] = [
  {
    id: "chemfig-structure",
    domain: "chemistry",
    feature: "requires a full LaTeX chemistry backend",
    latex: "\\chemfig{*6(-=-=-=)}",
    display: true
  },
  {
    id: "tikz-diagram",
    domain: "technical",
    feature: "requires a full LaTeX graphics backend",
    latex: "\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}",
    display: true
  },
  {
    id: "external-image",
    domain: "technical",
    feature: "external resource loading stays disabled",
    latex: "\\includegraphics{remote.pdf}",
    display: true
  }
];

/** Cases where a terminal Markdown renderer has removed normal TeX delimiters. */
export const SCIENTIFIC_TERMINAL_CORPUS: ScientificTerminalCase[] = [
  {
    id: "stripped-chemical-inline",
    domain: "chemistry",
    lines: ["The reaction is (\\ce{2 H2 + O2 -> 2 H2O})."],
    expectedLatex: "\\ce{2 H2 + O2 -> 2 H2O}"
  },
  {
    id: "stripped-physics-derivative",
    domain: "physics",
    lines: ["Velocity is (\\dv{x}{t})."],
    expectedLatex: "\\dv{x}{t}"
  },
  {
    id: "stripped-upright-greek",
    domain: "physics",
    lines: ["The prefix is (\\upmu)."],
    expectedLatex: "\\upmu"
  },
  {
    id: "stripped-si-units",
    domain: "physics",
    lines: ["Acceleration is (\\SI{9.81}{\\metre\\per\\second\\squared})."],
    expectedLatex: "\\SI{9.81}{\\metre\\per\\second\\squared}"
  },
  {
    id: "stripped-isotope-prescript",
    domain: "biology",
    lines: ["The tracer is (\\prescript{32}{}{P})."],
    expectedLatex: "\\prescript{32}{}{P}"
  },
  {
    id: "stripped-centered-negation",
    domain: "mathematics",
    lines: ["The result is (A\\centernot\\implies B)."],
    expectedLatex: "A\\centernot\\implies B"
  },
  {
    id: "stripped-multiline-display",
    domain: "biology",
    lines: [
      "[",
      "\\begin{aligned}\\dv{x}{t}&=\\alpha x-\\beta xy\\",
      "\\dv{y}{t}&=\\delta xy-\\gamma y",
      "\\end{aligned}",
      "]"
    ],
    expectedLatex: "\\begin{aligned}\\dv{x}{t}&=\\alpha x-\\beta xy\\\\\n"
      + "\\dv{y}{t}&=\\delta xy-\\gamma y\n\\end{aligned}",
    display: true
  },
  {
    id: "single-line-bare-brackets",
    domain: "chemistry",
    lines: ["[ \\Delta G^\\circ=-RT\\ln K ]"],
    expectedLatex: "\\Delta G^\\circ=-RT\\ln K",
    display: true
  }
];
