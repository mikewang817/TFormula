type SharpFactory = typeof import("sharp");

let sharpPromise: Promise<SharpFactory> | undefined;

/** Avoid loading Sharp's native module for text-only and formula-only documents. */
export function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= import("sharp").then((module) =>
    (module as unknown as { default: SharpFactory }).default);
  return sharpPromise;
}
