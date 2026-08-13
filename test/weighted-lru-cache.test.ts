import { describe, expect, it } from "vitest";
import { WeightedLruCache } from "../src/weighted-lru-cache.js";

describe("WeightedLruCache", () => {
  it("evicts by recency, entry count, and retained bytes", () => {
    const cache = new WeightedLruCache<string>(3, 10);
    cache.set("a", "A", 3);
    cache.set("b", "B", 3);
    cache.set("c", "C", 3);
    expect(cache.bytes).toBe(9);

    expect(cache.get("a")).toBe("A");
    cache.set("d", "D", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);

    cache.set("large", "L", 8);
    expect(cache.has("c")).toBe(false);
    expect(cache.has("d")).toBe(false);
    expect(cache.has("large")).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(10);
  });

  it("does not retain one entry larger than the byte budget", () => {
    const cache = new WeightedLruCache<string>(4, 5);
    cache.set("oversized", "value", 6);
    expect(cache.size).toBe(0);
  });
});
