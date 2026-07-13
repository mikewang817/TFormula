declare module "@mathjax/src" {
  const MathJax: unknown;
  export default MathJax;
  export function init(config?: Record<string, unknown>): Promise<unknown>;
}
