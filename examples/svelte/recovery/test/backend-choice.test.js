// SPDX-License-Identifier: MIT
/**
 * @fileoverview What the reader ticked, turned into a backend.
 *
 * Offline: building a backend contacts nobody, and these assert the shape the
 * bridge is handed rather than any upload. The part worth testing is the part
 * that is easy to get wrong — a gateway belongs to one service, so with
 * several chosen it has to be a map, and the bridge refuses a single string
 * rather than handing Pinata's gateway to Lighthouse.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { backendFor, SERVICES } from "../src/stack.js";

describe("the backend a choice builds", () => {
  test("one service is that driver", async () => {
    const backend = await backendFor([{ id: "aleph" }]);
    assert.equal(backend.name, "aleph");
  });

  test("two services are a mirror, so one backup lands on both", async () => {
    const backend = await backendFor([
      { id: "aleph" },
      { id: "pinata", key: "jwt", gateway: "https://silver-fox.mypinata.cloud" },
    ]);
    assert.match(backend.name, /mirror/);
  });

  test("a gateway reaches the driver it belongs to", async () => {
    // One service: the bridge takes a plain string.
    const backend = await backendFor([
      { id: "lighthouse", key: "k", gateway: "preferred-cat.lighthouseweb3.xyz" },
    ]);
    assert.equal(backend.name, "lighthouse");
  });

  test("two services with their own gateways are accepted", async () => {
    // The bridge refuses one string for several services — this is the shape
    // that has to be built instead, and it is the reason `backendFor` exists.
    const backend = await backendFor([
      { id: "pinata", key: "jwt", gateway: "https://silver-fox.mypinata.cloud" },
      { id: "lighthouse", key: "k", gateway: "https://preferred-cat.lighthouseweb3.xyz" },
    ]);
    assert.match(backend.name, /mirror/);
  });

  test("a service without its key is refused, with the service named", async () => {
    await assert.rejects(
      () => backendFor([{ id: "pinata" }]),
      (error) => /pinata/i.test(error.message),
    );
  });

  test("no service at all says so", async () => {
    await assert.rejects(() => backendFor([]), /at least one/i);
  });

  test("an unknown name is ignored rather than passed on", async () => {
    await assert.rejects(() => backendFor([{ id: "dropbox" }]), /at least one/i);
  });

  test("only Aleph needs no account, which is why it is the default", () => {
    const free = SERVICES.filter((s) => !s.needsKey).map((s) => s.id);
    assert.deepEqual(free, ["aleph"]);
  });
});
