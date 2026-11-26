import { beforeEach } from "vitest";

// The console keeps its page tabs in sessionStorage; every test starts with none.
beforeEach(() => {
  if (typeof window !== "undefined") window.sessionStorage.clear();
});
