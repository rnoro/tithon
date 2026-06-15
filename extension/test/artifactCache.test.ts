import { describe, it, expect } from "vitest";
import { ArtifactCache } from "../src/artifactCache";

const bytes = (n: number) => ({ bytes: new Uint8Array(n) });

describe("ArtifactCache (byte-budgeted LRU)", () => {
  it("evicts least-recently-used once over the byte budget", () => {
    // budget 250 bytes, generous entry cap.
    const c = new ArtifactCache<{ bytes: Uint8Array } | null>((v) => (v ? v.bytes.length : 0), 250, 100);
    c.set("a", bytes(100));
    c.set("b", bytes(100));
    c.get("a"); // touch a -> b is now the LRU
    c.set("c", bytes(100)); // 300 > 250 -> evict b
    expect(c.get("a")).toBeTruthy();
    expect(c.get("c")).toBeTruthy();
    expect(c.get("b")).toBeUndefined();
    expect(c.byteSize).toBeLessThanOrEqual(250);
  });

  it("bounds memory across a long stream of distinct frames (the live-plot case)", () => {
    const c = new ArtifactCache<{ bytes: Uint8Array } | null>((v) => (v ? v.bytes.length : 0), 1000, 100);
    for (let i = 0; i < 10000; i++) c.set(`frame${i}`, bytes(200));
    expect(c.byteSize).toBeLessThanOrEqual(1000);
    expect(c.entries).toBeLessThanOrEqual(100);
    expect(c.get("frame9999")).toBeTruthy(); // newest retained
    expect(c.get("frame0")).toBeUndefined(); // oldest evicted
  });

  it("caches null (not-found) without counting bytes, capped by entry count", () => {
    const c = new ArtifactCache<{ bytes: Uint8Array } | null>((v) => (v ? v.bytes.length : 0), 1 << 20, 3);
    c.set("x", null);
    c.set("y", null);
    c.set("z", null);
    expect(c.get("x")).toBeNull(); // distinct from undefined (= absent)
    c.set("w", null); // size 4 > cap 3 -> evict oldest (y, since x was just touched)
    expect(c.entries).toBe(3);
    expect(c.byteSize).toBe(0);
  });
});
