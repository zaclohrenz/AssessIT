import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { verifySignature } from "../scripts/updater-manifest.mjs";

// sample.bin was signed for 1.2.3 with a throwaway test key (test.pub); other.pub belongs to a different key.
const dir = new URL("./fixtures/updater/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, dir));
const text = (f: string) => read(f).toString().trim();

describe("updater manifest signature check", () => {
  it("accepts a good signature and returns the version it was signed for", () => {
    expect(verifySignature(read("sample.bin"), text("sample.bin.sig"), text("test.pub"))).toBe("1.2.3");
  });
  it("rejects a file that changed after signing", () => {
    expect(() => verifySignature(Buffer.from("tampered"), text("sample.bin.sig"), text("test.pub"))).toThrow(/doesn't match/);
  });
  it("rejects a signature made with a different key", () => {
    expect(() => verifySignature(read("sample.bin"), text("sample.bin.sig"), text("other.pub"))).toThrow(/different key/);
  });
  it("rejects a malformed signature or key", () => {
    expect(() => verifySignature(read("sample.bin"), "bm9wZQ==", text("test.pub"))).toThrow(/malformed/);
    expect(() => verifySignature(read("sample.bin"), text("sample.bin.sig"), "bm9wZQ==")).toThrow(/not a valid/);
  });
});
