/**
 * @fileoverview A backend from a name and a key — what a page has, rather than
 * what a Node caller has.
 *
 * Offline, and deliberately not a test of the vendors: what is asserted here is
 * that a choice is turned into the right driver, that a missing credential is
 * refused with the service named rather than at the first upload, and that
 * several choices become a mirror instead of a loop in the caller.
 */

import { describe, test, expect } from "@jest/globals";
import {
  createBackendFromChoice,
  BACKEND_KINDS,
} from "../../lib/backends/choose.js";

describe("a backend from a choice", () => {
  test("aleph needs nothing, which is why it is the default anywhere", async () => {
    const backend = await createBackendFromChoice({ kind: "aleph" });
    expect(backend.name).toBe("aleph");
    expect(backend.capabilities.browserSafeAuth).toBe(true);
  });

  test("a missing key is refused here, with the service named", async () => {
    await expect(
      createBackendFromChoice({ kind: "lighthouse" }),
    ).rejects.toThrow(/Lighthouse needs an apiKey/);
    await expect(createBackendFromChoice({ kind: "pinata" })).rejects.toThrow(
      /Pinata needs a JWT, or a getUploadUrl/,
    );
  });

  test("whose Lighthouse key it is decides whether a page may hold it", async () => {
    const shared = await createBackendFromChoice({
      kind: "lighthouse",
      apiKey: "x",
    });
    const own = await createBackendFromChoice({
      kind: "lighthouse",
      apiKey: "x",
      keyOwnership: "user",
    });
    expect(shared.capabilities.browserSafeAuth).toBe(false);
    expect(own.capabilities.browserSafeAuth).toBe(true);
  });

  test("several kinds become a mirror", async () => {
    const backend = await createBackendFromChoice({
      kind: ["aleph", "memory"],
    });
    expect(backend.name).toBe("mirror(aleph+memory)");
    expect(backend.backends).toHaveLength(2);
  });

  test("an unknown or missing name says what the choices are", async () => {
    await expect(createBackendFromChoice({ kind: "dropbox" })).rejects.toThrow(
      /Unknown backend "dropbox"/,
    );
    await expect(createBackendFromChoice({})).rejects.toThrow(/Pick a backend/);
    expect(BACKEND_KINDS).toContain("lighthouse");
  });

  test("resolveBackend takes the same choice, so there is one decision", async () => {
    const { resolveBackend } = await import("../../lib/backends/resolve.js");
    const backend = await resolveBackend({ kind: "memory" });
    expect(backend.name).toBe("memory");
  });
});
