/**
 * @fileoverview The STORE message: what gets signed, and what does not get seen.
 *
 * Two properties matter more than the wire format, and both are easy to lose
 * in a later refactor without anything turning red:
 *
 * 1. **The library never sees a key.** `sign` is called with an address and a
 *    string, and nothing else is ever handed to it or read from it.
 * 2. **A 202 is not a promise.** Aleph accepts the message before checking the
 *    signature or the balance, so reporting it as kept would be exactly the lie
 *    this module was written to avoid.
 */

import { jest, describe, test, expect } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  buildStoreMessage,
  buildAuthorizationMessage,
  signaturePayload,
  createAlephPin,
  createAlephAuthorizer,
  waitForMessage,
  listAlephStores,
  DEFAULT_ALEPH_CHANNEL,
  STORE_PAYMENTS,
} from "../../lib/backends/aleph-pin.js";
import { createAlephBackend } from "../../lib/backends/aleph.js";
import { BackendError } from "../../lib/backends/types.js";

jest.setTimeout(30_000);

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const CID = "QmXFP7bcUKHowZN2faFrEdiABN1E6raBiRsQbGCtb5Fnwn";
const SIGNATURE = "0x" + "ab".repeat(65);

/** A fetch that records what it was asked to do and answers like Aleph. */
function recordingFetch(response = { status: 202, body: { message_status: "pending" } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.status < 300,
      status: response.status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe("the STORE message", () => {
  test("is the envelope relay-button already posts, with a different type", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1_757_000_000 });

    expect(message.chain).toBe("ETH");
    expect(message.type).toBe("STORE");
    expect(message.item_type).toBe("inline");
    expect(message.channel).toBe(DEFAULT_ALEPH_CHANNEL);

    // The hash is over the serialised content, and it is hex sha-256. Checked
    // against node's own implementation rather than against itself.
    const expected = createHash("sha256").update(message.item_content).digest("hex");
    expect(message.item_hash).toBe(expected);
  });

  test("names the CID in the content, where the meaning of the fields flips", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1 });
    const content = JSON.parse(message.item_content);

    expect(content.address).toBe(ADDRESS);
    // In the envelope, `item_type: inline` means "the body is here". In the
    // content it means "the thing to keep is an IPFS CID" — same name, other
    // subject, and the reason this test exists.
    expect(content.item_type).toBe("ipfs");
    expect(content.item_hash).toBe(CID);
    expect(message.item_type).toBe("inline");
  });

  test("what the wallet puts its name to is four fields, in order", async () => {
    const message = await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1 });
    expect(signaturePayload(message)).toBe(
      ["ETH", ADDRESS, "STORE", message.item_hash].join("\n"),
    );
  });

  test("is paid in credits unless told otherwise", async () => {
    // Without `payment` Aleph books a STORE as `hold` — locked ALEPH, which a
    // credit-funded account does not have (measured 2026-10-03). `credit` is
    // what Aleph's own CLI sends by default.
    const paid = JSON.parse((await buildStoreMessage({ sender: ADDRESS, cid: CID, now: 1 })).item_content);
    expect(paid.payment).toEqual({ type: "credit" });

    const held = JSON.parse((await buildStoreMessage({ sender: ADDRESS, cid: CID, payment: "hold", now: 1 })).item_content);
    expect(held.payment).toEqual({ type: "hold" });

    // `null` sends what every version up to 0.16.1 sent: no payment at all.
    const bare = JSON.parse((await buildStoreMessage({ sender: ADDRESS, cid: CID, payment: null, now: 1 })).item_content);
    expect(bare).not.toHaveProperty("payment");

    expect(STORE_PAYMENTS).toEqual(["credit", "hold"]);
    await expect(buildStoreMessage({ sender: ADDRESS, cid: CID, payment: "stream" })).rejects.toThrow(/credit.*hold/);
  });
});

describe("pinning", () => {
  test("hands the signer an address and a string, and nothing else", async () => {
    const seen = [];
    const sign = async (...args) => {
      seen.push(args);
      return SIGNATURE;
    };
    const fetchImpl = recordingFetch();

    const pin = createAlephPin({ sender: ADDRESS, sign, fetch: fetchImpl });
    await pin(CID);

    expect(seen).toHaveLength(1);
    const [address, payload] = seen[0];
    expect(address).toBe(ADDRESS);
    expect(typeof payload).toBe("string");
    // The property, stated as an assertion: nothing beyond those two arguments
    // is offered to the signer, so there is nothing for it to leak back.
    expect(seen[0]).toHaveLength(2);
  });

  test("posts the signed message to the messages endpoint", async () => {
    const fetchImpl = recordingFetch();
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: fetchImpl,
    });

    const result = await pin(CID);

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, body } = fetchImpl.calls[0];
    expect(url).toBe("https://api2.aleph.im/api/v0/messages");
    expect(body.message.signature).toBe(SIGNATURE);
    expect(body.message.type).toBe("STORE");
    expect(result.itemHash).toBe(body.message.item_hash);
  });

  test("the posted STORE is paid in credits, or as the caller says", async () => {
    const credit = recordingFetch();
    await createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: credit })(CID);
    expect(JSON.parse(credit.calls[0].body.message.item_content).payment).toEqual({ type: "credit" });

    const none = recordingFetch();
    await createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: none, payment: null })(CID);
    expect(JSON.parse(none.calls[0].body.message.item_content)).not.toHaveProperty("payment");
  });

  test("a bare signature is 0x-prefixed, because Aleph wants one", async () => {
    const fetchImpl = recordingFetch();
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => "ab".repeat(65),
      fetch: fetchImpl,
    });
    await pin(CID);
    expect(fetchImpl.calls[0].body.message.signature).toBe(SIGNATURE);
  });

  test("202 is reported as pending, not as kept", async () => {
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: recordingFetch({ status: 202, body: { message_status: "pending" } }),
    });

    // Aleph takes the message before it checks the signature or the balance.
    // Anything that reads as "done" here would be a promise nobody made.
    await expect(pin(CID)).resolves.toMatchObject({ status: "pending" });
  });

  test("a refusal is an error, with what the service said", async () => {
    const pin = createAlephPin({
      sender: ADDRESS,
      sign: async () => SIGNATURE,
      fetch: recordingFetch({ status: 422, body: { details: "InvalidMessageFormat" } }),
    });
    await expect(pin(CID)).rejects.toThrow(/refused the STORE message: 422/);
  });

  test("it refuses to be built without the things it cannot work without", () => {
    expect(() => createAlephPin({ sign: async () => "" })).toThrow(BackendError);
    expect(() => createAlephPin({ sender: ADDRESS })).toThrow(/sign/);
  });
});

describe("wired into the backend", () => {
  test("supplying pin is what declares pinByCid — and omitting it is honest", async () => {
    const withWallet = createAlephBackend({
      pin: createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: recordingFetch() }),
    });
    expect(withWallet.capabilities.pinByCid).toBe(true);
    expect(typeof withWallet.pinCid).toBe("function");

    const without = createAlephBackend();
    expect(without.capabilities.pinByCid).toBe(false);
    expect(without.pinCid).toBeUndefined();
  });

  test("a pinned handle says our CID survived, and is retained once Aleph processed the STORE", async () => {
    const backend = createAlephBackend({
      pin: createAlephPin({
        sender: ADDRESS,
        sign: async () => SIGNATURE,
        fetch: recordingFetch({ status: 200, body: { message_status: "processed" } }),
      }),
    });

    const handle = await backend.pinCid(CID);
    // Pin-by-CID is the one path where the id *is* ours, because we gave it.
    expect(handle.id).toBe(CID);
    expect(handle.cid).toBe(CID);
    expect(handle.retained).toBe(true);
    expect(handle.status).toBe("processed");
    expect(handle.itemHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a pending STORE is not reported as kept, and carries what to follow it by", async () => {
    const backend = createAlephBackend({
      pin: createAlephPin({ sender: ADDRESS, sign: async () => SIGNATURE, fetch: recordingFetch() }),
    });
    const handle = await backend.pinCid(CID);
    expect(handle.retained).toBe(false);
    expect(handle.status).toBe("pending");
    expect(handle.itemHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a pin of one's own that reports nothing keeps the old answer", async () => {
    const backend = createAlephBackend({ pin: async () => undefined });
    const handle = await backend.pinCid(CID);
    expect(handle.retained).toBe(true);
    expect(handle).not.toHaveProperty("status");
  });

  test("an upload is never retained by itself, with or without pin", async () => {
    // Up to 0.16.1 putBlob said `retained: Boolean(pin)` although it never
    // sends a STORE; keeping is what pinCid does.
    const ingest = async (url, init) => {
      expect(url).toBe("https://ipfs.aleph.cloud/api/v0/add");
      expect(init.method).toBe("POST");
      return { ok: true, status: 200, text: async () => JSON.stringify({ Name: "blob", Hash: CID, Size: "3" }) };
    };
    const withPin = createAlephBackend({ fetch: ingest, pin: async () => ({ itemHash: "x", status: "processed" }) });
    expect((await withPin.putBlob(new Uint8Array([1, 2, 3]))).retained).toBe(false);
    const without = createAlephBackend({ fetch: ingest });
    expect((await without.putBlob(new Uint8Array([1, 2, 3]))).retained).toBe(false);
  });
});

/** A fetch for GET requests that answers from a list, one answer per call, and records the URLs. */
function answeringFetch(answers) {
  const urls = [];
  const fetchImpl = async (url, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    urls.push(url);
    const answer = answers[Math.min(urls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}

describe("following a STORE", () => {
  const HASH = "a".repeat(64);
  const noWait = async () => {};

  test("asks until Aleph has decided, and says processed", async () => {
    const fetchImpl = answeringFetch([
      { status: 404, body: { error: "Message not found" } },
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { status: "processed" } },
    ]);
    const result = await waitForMessage(HASH, { fetch: fetchImpl, sleep: noWait });
    expect(result).toEqual({ itemHash: HASH, status: "processed" });
    expect(fetchImpl.urls).toEqual(Array(3).fill(`https://api2.aleph.im/api/v0/messages/${HASH}`));
  });

  test("a rejection says why — for credit, how much was there and how much is needed", async () => {
    // The answer as Aleph gave it on 2026-10-03 for 2 MiB on an account with no credit.
    const details = { errors: [{ account_credits: "0", min_runtime_days: 1, required_credits: "107.804934183756585600" }] };
    const fetchImpl = answeringFetch([{ status: 200, body: { status: "rejected", error_code: 6, details } }]);
    await expect(waitForMessage(HASH, { fetch: fetchImpl, sleep: noWait })).resolves.toEqual({
      itemHash: HASH,
      status: "rejected",
      errorCode: 6,
      details,
    });
  });

  test("still pending when the time is up is reported as that, not thrown", async () => {
    const slept = [];
    const fetchImpl = answeringFetch([new Error("socket hang up"), { status: 200, body: { status: "pending" } }]);
    const result = await waitForMessage(HASH, {
      fetch: fetchImpl,
      timeout: 6_000,
      interval: 2_000,
      sleep: async (ms) => slept.push(ms),
    });
    expect(result).toEqual({ itemHash: HASH, status: "pending", timedOut: true });
    // Asked at once, then every interval until the timeout: 0, 2, 4, 6 seconds.
    expect(fetchImpl.urls).toHaveLength(4);
    expect(slept).toEqual([2_000, 2_000, 2_000]);
  });

  test("it needs the item hash", async () => {
    await expect(waitForMessage("", { fetch: answeringFetch([]) })).rejects.toThrow(/item hash/);
  });
});

describe("listing what an account keeps", () => {
  const OWNER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  const DELEGATE = "0x9999999999999999999999999999999999999999";
  const store = (itemHash, cid, time, extra = {}) => ({
    item_hash: itemHash,
    sender: DELEGATE,
    channel: "SOME-BACKUP",
    content: { address: OWNER, item_type: "ipfs", item_hash: cid, payment: { type: "credit" }, time },
    ...extra,
  });

  test("asks by owner, not by sender, and answers newest first", async () => {
    const fetchImpl = answeringFetch([
      {
        status: 200,
        body: {
          pagination_total: 2,
          messages: [store("h1", "Qm1", 100), store("h2", "Qm2", 200)],
        },
      },
    ]);
    const { stores, total } = await listAlephStores({ owner: OWNER, channel: "SOME-BACKUP", fetch: fetchImpl });

    const url = new URL(fetchImpl.urls[0]);
    expect(url.origin + url.pathname).toBe("https://api2.aleph.im/api/v0/messages.json");
    // `addresses` matches the sender and misses a delegate's STORE (measured
    // 2026-10-03); `owners` matches the account the STORE is for.
    expect(url.searchParams.get("owners")).toBe(OWNER);
    expect(url.searchParams.has("addresses")).toBe(false);
    expect(url.searchParams.get("msgTypes")).toBe("STORE");
    expect(url.searchParams.get("channels")).toBe("SOME-BACKUP");

    expect(total).toBe(2);
    expect(stores).toEqual([
      { cid: "Qm2", itemHash: "h2", sender: DELEGATE, owner: OWNER, time: 200, channel: "SOME-BACKUP", payment: "credit" },
      { cid: "Qm1", itemHash: "h1", sender: DELEGATE, owner: OWNER, time: 100, channel: "SOME-BACKUP", payment: "credit" },
    ]);
  });

  test("keeps only this owner's STOREs, and only those that name something", async () => {
    const foreign = store("h3", "Qm3", 300);
    foreign.content = { ...foreign.content, address: "0x1111111111111111111111111111111111111111" };
    const empty = store("h4", "", 400);
    const fetchImpl = answeringFetch([
      { status: 200, body: { messages: [store("h1", "Qm1", 100, { sender: OWNER }), foreign, empty] } },
    ]);
    const { stores, total } = await listAlephStores({ owner: OWNER.toLowerCase(), fetch: fetchImpl });
    expect(stores.map((s) => s.itemHash)).toEqual(["h1"]);
    expect(total).toBeNull();
    expect(new URL(fetchImpl.urls[0]).searchParams.has("channels")).toBe(false);
  });

  test("a refusal is an error, and the owner is required", async () => {
    await expect(
      listAlephStores({ owner: OWNER, fetch: answeringFetch([{ status: 503, body: {} }]) }),
    ).rejects.toThrow(/did not list the STORE messages: 503/);
    await expect(listAlephStores({ fetch: answeringFetch([]) })).rejects.toThrow(/owner/);
  });
});

describe("signing for another account", () => {
  const OWNER = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  const DELEGATE = "0x9999999999999999999999999999999999999999";

  test("a delegate's STORE is signed by the delegate and names the owner", async () => {
    const fetchImpl = recordingFetch();
    const seen = [];
    const pin = createAlephPin({
      sender: DELEGATE,
      owner: OWNER,
      sign: async (address, payload) => (seen.push([address, payload]), SIGNATURE),
      fetch: fetchImpl,
    });
    await pin(CID);

    const { message } = fetchImpl.calls[0].body;
    expect(message.sender).toBe(DELEGATE);
    expect(JSON.parse(message.item_content).address).toBe(OWNER);
    // The delegate signs, over its own address: the owner's key is not involved.
    expect(seen[0][0]).toBe(DELEGATE);
    expect(seen[0][1]).toBe(signaturePayload(message));
  });

  test("without an owner nothing changes: the content names the sender", async () => {
    const message = await buildStoreMessage({ sender: DELEGATE, cid: CID, now: 1 });
    expect(JSON.parse(message.item_content).address).toBe(DELEGATE);
  });

  test("the grant is the owner's AGGREGATE on the security channel, the whole list in it", async () => {
    const authorizations = [{ address: DELEGATE, types: ["STORE"], channels: ["BELEGE-BACKUP"], chain: "ETH" }];
    const message = await buildAuthorizationMessage({ owner: OWNER, authorizations, now: 7 });
    expect(message).toMatchObject({ sender: OWNER, chain: "ETH", type: "AGGREGATE", channel: "security", item_type: "inline" });
    expect(JSON.parse(message.item_content)).toEqual({
      address: OWNER,
      key: "security",
      content: { authorizations },
      time: 7,
    });
    expect(message.item_hash).toBe(createHash("sha256").update(message.item_content).digest("hex"));
    await expect(buildAuthorizationMessage({ owner: OWNER, authorizations: [{ types: ["STORE"] }] })).rejects.toThrow(
      /delegate's address/,
    );
  });

  /** A fetch that answers the owner's security aggregate, and records posts. */
  function aggregateFetch(existing) {
    const posts = [];
    const fetchImpl = async (url, init) => {
      if (!init) {
        expect(url).toBe(`https://api2.aleph.im/api/v0/aggregates/${OWNER}.json?keys=security`);
        if (!existing) return { ok: false, status: 404, json: async () => ({}), text: async () => "No aggregate found" };
        return {
          ok: true,
          status: 200,
          json: async () => ({ address: OWNER, data: { security: { authorizations: existing } } }),
        };
      }
      posts.push(JSON.parse(init.body).message);
      return { ok: true, status: 200, json: async () => ({ message_status: "processed" }), text: async () => "" };
    };
    fetchImpl.posts = posts;
    return fetchImpl;
  }

  test("authorize keeps the other grants and replaces one for the same address; revoke takes one away", async () => {
    const other = { address: "0x1111111111111111111111111111111111111111", types: ["POST"] };
    const old = { address: DELEGATE.toUpperCase().replace("0X", "0x"), types: ["STORE"] };
    const fetchImpl = aggregateFetch([other, old]);
    const signed = [];
    const authorizer = createAlephAuthorizer({
      owner: OWNER,
      sign: async (address) => (signed.push(address), SIGNATURE),
      fetch: fetchImpl,
    });

    const granted = await authorizer.authorize({ address: DELEGATE, types: ["STORE"], channels: ["BELEGE-BACKUP"] });
    expect(granted.status).toBe("processed");
    expect(JSON.parse(fetchImpl.posts[0].item_content).content.authorizations).toEqual([
      other,
      { address: DELEGATE, types: ["STORE"], channels: ["BELEGE-BACKUP"] },
    ]);
    expect(signed).toEqual([OWNER]);

    await authorizer.revoke(DELEGATE);
    expect(JSON.parse(fetchImpl.posts[1].item_content).content.authorizations).toEqual([other]);
  });

  test("an owner with no permissions yet reads as none, and the first grant is the whole list", async () => {
    const fetchImpl = aggregateFetch(null);
    const authorizer = createAlephAuthorizer({ owner: OWNER, sign: async () => SIGNATURE, fetch: fetchImpl });
    expect(await authorizer.read()).toEqual([]);
    await authorizer.authorize({ address: DELEGATE, types: ["STORE"] });
    expect(JSON.parse(fetchImpl.posts[0].item_content).content.authorizations).toEqual([
      { address: DELEGATE, types: ["STORE"] },
    ]);
  });

  test("it refuses to be built without the owner or a signer", () => {
    expect(() => createAlephAuthorizer({ sign: async () => SIGNATURE })).toThrow(/owner/);
    expect(() => createAlephAuthorizer({ owner: OWNER })).toThrow(/sign/);
  });
});
