import { describe, expect, it } from "vitest";
import { buildLabel, buildStep } from "../version";

const A = "0123456789abcdef0123456789abcdef01234567";
const B = "fedcba9876543210fedcba9876543210fedcba98";

describe("build version", () => {
  it("shows a commit as its short form and anything else as it is", () => {
    expect(buildLabel(A)).toBe("0123456");
    expect(buildLabel("dev")).toBe("dev");
  });

  it("does nothing while the gateway runs this page's build, or says nothing", () => {
    expect(buildStep(A, A, false)).toBe("none");
    expect(buildStep(A, null, true)).toBe("none");
  });

  it("reloads a hidden page on a new build, and asks on a page in use", () => {
    expect(buildStep(A, B, true)).toBe("reload");
    expect(buildStep(A, B, false)).toBe("notify");
  });
});
