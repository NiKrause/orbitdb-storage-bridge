/**
 * @fileoverview Fetching bytes by CID from peers, when a gateway will not do.
 *
 * `gateway-fetch.js` is the HTTP half of this: ask a host, hope it answers.
 * That stopped being a plan on 2026-09-21, when the public path gateways were
 * retired (#111) and every fallback list in this package turned out to be one
 * live entry and a dead tail. This is the other half — ask the peers that
 * actually hold the blocks.
 *
 * ## Measured before it was written
 *
 * From a real page (Chrome, no build step, Helia loaded as ES modules), on
 * 2026-09-23:
 *
 * ```
 * Pinata      dial 729 ms over wss            bitswap 263 ms
 * Lighthouse  dial 581 ms over webrtc-direct  bitswap 323 ms
 * Aleph       dial 450 ms over webrtc-direct  bitswap 345 ms
 * ```
 *
 * No credential in any of it, while both paid providers' HTTP gateways want
 * that account's key and Lighthouse's shared gateway answers 402 for content
 * it does not hold. Three services, two transports, about a second each.
 *
 * ## The peer list follows the backends, and nothing else
 *
 * There is no default provider here, and that is deliberate. Whoever stores
 * with a service already shares their CIDs with it, so reading from it adds no
 * new party — but a page that dials Pinata having never uploaded there would
 * be telling Pinata what its reader is looking for, in exchange for nothing.
 * The caller names the providers. {@link PINATA_BITSWAP} is a constant because
 * Pinata publishes it in DNS; everyone else has to be looked up.
 *
 * ## What the caller has to bring
 *
 * A Helia with bitswap **and identify**. This module has no libp2p of its own —
 * the page that restores already has a node, and a second one would be a second
 * identity on the network.
 *
 * Two things about that node are easy to get wrong, and both were:
 *
 * - **`identify` is not optional.** `withLibp2pLight` does not include it, and
 *   without it bitswap never learns that the peer it just dialled speaks
 *   bitswap: no want is sent, and the fetch fails with "Failed to load block"
 *   after the full timeout. Measured against Aleph: 60 s of nothing without
 *   identify, 1.6 s for 400 kB with it, over the same dialled connection.
 * - **Helia's browser defaults try to listen** on `/webrtc` and `/p2p-circuit`
 *   and **throw on start** when no transport serves them, so a fetch-only node
 *   wants `addresses: { listen: [] }`.
 *
 * ```js
 * const helia = await withBitswap(withLibp2pLight(createHeliaLight({ … }), {
 *   addresses: { listen: [] },
 *   transports: [webSockets(), webRTCDirect()],
 *   connectionEncrypters: [noise()],
 *   streamMuxers: [yamux()],
 *   services: { identify: identify() },   // ← without this, nothing arrives
 * })).start()
 * ```
 *
 * @module peer-fetch
 */

/**
 * Pinata's bitswap endpoint, published in DNS:
 *
 * ```
 * $ dig +short TXT _dnsaddr.bitswap-v3.pinata.cloud
 * "dnsaddr=/dns4/bitswap-v3.pinata.cloud/tcp/443/wss/p2p/Qmdv6yNikmUWUWXufLJLRNkv6Y9sY5cmgeX5RVWA4WNMz4"
 * ```
 *
 * A DNS name on 443 with a CA certificate is dialable from a page, which is
 * what makes it worth naming here rather than looking up per CID.
 */
export const PINATA_BITSWAP =
  "/dns4/bitswap-v3.pinata.cloud/tcp/443/wss/p2p/Qmdv6yNikmUWUWXufLJLRNkv6Y9sY5cmgeX5RVWA4WNMz4";

/**
 * Aleph's own node — a fallback, not an address to trust.
 *
 * It publishes no `_dnsaddr` and answers `404` to `/api/v0/id`, so looking for
 * it the way Pinata is found says it has no peer. It does: ask a router for
 * the providers of a CID Aleph holds.
 *
 * **Prefer {@link providersFor}.** Three things that were written here as
 * guarantees have since been disproved, each by measurement on 2026-10-29:
 *
 * - **The peer id is not the stable part.** This file said the certhash
 *   rotates while the peer id outlives it. The routing now answers with
 *   `12D3KooWJBw9…`, where it used to answer `12D3KooWACE5…` — a different
 *   node, so every address here was dead and nothing said so.
 * - **A page may look up after all.** `delegated-ipfs.dev` does send
 *   `access-control-allow-origin: *` for provider lookups now (200 with the
 *   header, from an origin of our own), so the reason this constant existed —
 *   that a browser could not ask — no longer holds. `cid.contact` still does
 *   not know Aleph's CIDs, because Aleph announces over the DHT and not IPNI.
 * - **The node is reachable over IPv6 only.** Every address it announces is
 *   `/ip6/` or `/dns6/`, so a page on a network without IPv6 cannot dial it at
 *   whatever address this constant holds. See `offNetworkRisk` in the
 *   webrtc-qr package for how differently browsers report that.
 *
 * What is below is what the routing announced on 2026-10-29. The two
 * `/dns6/…libp2p.direct/tcp/4001/tls/ws` addresses carry no certificate hash
 * and so do not rot when the node restarts; the `webrtc-direct` ones do.
 * `test/peer-fetch-live.test.js` checks the peer id against the routing, which
 * is how this gets noticed next time rather than in a demo six weeks later.
 */
export const ALEPH_BITSWAP = Object.freeze([
  "/dns6/2a01-240-ad00-0-a81e-30ff-fe24-e1c8.k51qzi5uqu5dja77dpum225l7jiqrxsfjg2cflzyewf8ixq3r7dmcku10s6l5o.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co",
  "/dns6/2a01-240-ad00-2-a81e-30ff-fe24-e1c8.k51qzi5uqu5dja77dpum225l7jiqrxsfjg2cflzyewf8ixq3r7dmcku10s6l5o.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co",
  "/ip6/2a01:240:ad00:0:a81e:30ff:fe24:e1c8/udp/4001/webrtc-direct/certhash/uEiBshqkW727Q236d7ivxBGMuc0E9Tsj3FZJMKJJgDuP4Lg/p2p/12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co",
  "/ip6/2a01:240:ad00:2:a81e:30ff:fe24:e1c8/udp/4001/webrtc-direct/certhash/uEiBshqkW727Q236d7ivxBGMuc0E9Tsj3FZJMKJJgDuP4Lg/p2p/12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co",
]);

/**
 * Aleph's peer id, as announced on 2026-10-29.
 *
 * Not the stable part: it changed once already, which is what made every
 * address above dead until this commit.
 */
export const ALEPH_PEER_ID =
  "12D3KooWJBw9CSUWQi7P7amZsjrsBAzoB2gJzyUUGkuBkdLc87co";

/**
 * Routers that answer a page.
 *
 * Both send `access-control-allow-origin: *` for provider lookups. An earlier
 * version of this file said `delegated-ipfs.dev` did not, from one request that
 * came back without the header; repeated from a deployed page it answers with
 * it, so the restriction was wrong and this list is both.
 *
 * What is true, and matters more, is that they know **different things**:
 * `cid.contact` is an IPNI index and knows what is announced to it — Pinata's
 * CIDs and Lighthouse's were there — while a CID that Aleph holds appeared only
 * at `delegated-ipfs.dev`, because Aleph announces over the DHT. Asking one
 * router is asking half the network.
 */
export const DEFAULT_ROUTERS = Object.freeze([
  "https://cid.contact",
  "https://delegated-ipfs.dev",
]);

/** @deprecated Same as {@link DEFAULT_ROUTERS}; kept so an import still works. */
export const ALL_ROUTERS = DEFAULT_ROUTERS;

/**
 * Transports a browser can dial.
 *
 * `tcp` and plain `quic-v1` are not here: a page has no raw sockets. `tls/ws`
 * needs a name rather than an IP, since the certificate has to match — an
 * AutoTLS `libp2p.direct` address qualifies only while that name resolves,
 * which for one provider it did not on the day this was written.
 */
export const BROWSER_TRANSPORTS = Object.freeze([
  "/wss",
  "/tls/ws",
  "/webtransport",
  "/webrtc-direct",
]);

const DEFAULT_TIMEOUT_MS = 30_000;

/** Quiet by default, like `gateway-fetch.js`. */
export const SILENT = { info() {}, warn() {}, debug() {} };

/** Does this multiaddr use a transport a page can open? */
export function isBrowserDialable(addr) {
  if (typeof addr !== "string") return false;
  if (!BROWSER_TRANSPORTS.some((transport) => addr.includes(transport)))
    return false;
  // A certificate cannot be issued for a bare IP, so ws/wss on one is not
  // dialable however well-formed it looks; webtransport and webrtc-direct
  // carry a certhash instead and are fine.
  const needsName = addr.includes("/wss") || addr.includes("/tls/ws");
  return !needsName || addr.includes("/dns");
}

/**
 * Who says they hold this CID, and at what address.
 *
 * @param {string} cid
 * @param {Object} [options]
 * @param {string[]} [options.routers] - delegated routing endpoints
 * @param {boolean} [options.dialableOnly=true] - keep only what a page can open
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * The addresses come back **with `/p2p/<id>` appended**, because that is what
 * dialling one needs and composing it is the kind of step every caller gets
 * right until the day it does not: the recovery example dropped the id on the
 * floor and its peer path had never once worked. The `id` is returned beside
 * them for identifying a provider, not for rebuilding the address.
 *
 * @returns {Promise<Array<{ id: string, addrs: string[] }>>}
 */
export async function providersFor(
  cid,
  {
    routers = DEFAULT_ROUTERS,
    dialableOnly = true,
    signal = null,
    fetchImpl = fetch,
    log = SILENT,
  } = {},
) {
  const found = new Map();

  for (const router of routers) {
    try {
      const response = await fetchImpl(
        `${router}/routing/v1/providers/${cid}`,
        {
          headers: { Accept: "application/json" },
          signal,
        },
      );
      if (!response.ok) {
        log.debug(`   ⚠️ ${router} answered ${response.status}`);
        continue;
      }
      const body = await response.text();
      for (const record of parseProviderRecords(body)) {
        const id = record.ID ?? record.id;
        if (!id) continue;
        const addrs = (record.Addrs ?? record.addrs ?? [])
          .filter((addr) => !dialableOnly || isBrowserDialable(addr))
          .map((addr) => (addr.includes("/p2p/") ? addr : `${addr}/p2p/${id}`));
        if (addrs.length === 0) continue;
        const already = found.get(id);
        if (already) {
          for (const addr of addrs)
            if (!already.addrs.includes(addr)) already.addrs.push(addr);
        } else {
          found.set(id, { id, addrs: [...addrs] });
        }
      }
    } catch (error) {
      log.debug(`   ⚠️ ${router} failed: ${error.message}`);
    }
  }

  return [...found.values()];
}

/**
 * A routing answer is JSON, or one JSON object per line when the router
 * streams — both shapes are in the spec, and both are in the wild.
 */
function parseProviderRecords(body) {
  const records = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value.Providers)) records.push(...value.Providers);
    else if (Array.isArray(value.providers)) records.push(...value.providers);
    else records.push(value);
  };
  try {
    push(JSON.parse(body));
    return records;
  } catch {
    // not one document — try it as a stream of them
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      push(JSON.parse(trimmed));
    } catch {
      // a partial line at the end of a stream; nothing to do with it
    }
  }
  return records;
}

/**
 * Build a `fetchBytes(cid)` that goes over libp2p.
 *
 * Fits where `restoreFromCID`'s `fetchBytes` goes, so nothing downstream
 * changes: the blocks are verified against their CIDs exactly as before, which
 * is what makes a stranger's bytes as safe as a gateway's.
 *
 * @param {Object} options
 * @param {Object} options.helia - a started Helia **with bitswap**
 * @param {string[] | ((cid: string) => Promise<string[]>)} options.providers -
 *   multiaddrs to dial, or a function that finds them for a CID
 * @param {number} [options.timeout]
 * @param {(addr: string) => Promise<unknown>} [options.dial] - defaults to the node's
 * @param {(cid: any, options?: Object) => AsyncIterable<Uint8Array>} [options.cat] -
 *   defaults to `@helia/unixfs`, which reads a chunked file as well as a single block
 * @returns {(cid: string, options?: Object) => Promise<Uint8Array>}
 */
export function createPeerFetch({
  helia,
  providers = [],
  timeout = DEFAULT_TIMEOUT_MS,
  dial = null,
  cat = null,
  log = SILENT,
} = {}) {
  if (!helia && (!dial || !cat)) {
    throw new Error("createPeerFetch needs a Helia node, or both dial and cat");
  }

  return async function fetchOverPeers(cid, options = {}) {
    const signal =
      options.signal ?? AbortSignal.timeout(options.timeout ?? timeout);
    const addrs =
      typeof providers === "function" ? await providers(cid) : [...providers];

    if (addrs.length === 0) {
      throw new Error(`No provider to dial for ${cid}`);
    }

    const dialOne =
      dial ??
      (async (addr) => {
        const { multiaddr } = await import("@multiformats/multiaddr");
        return helia.libp2p.dial(multiaddr(addr), { signal });
      });

    // One connection per peer, not one per address. A provider usually
    // advertises the same peer several times — Aleph offers webrtc-direct and
    // webtransport — and dialling both gets two connections to one node, which
    // buys nothing and makes a peer count read double.
    const reached = new Set();
    for (const addr of addrs) {
      const peer = addr.match(/\/p2p\/([^/]+)/)?.[1] ?? addr;
      if (reached.has(peer)) continue;
      try {
        await dialOne(addr);
        reached.add(peer);
        log.debug(`   ✅ dialled ${addr}`);
      } catch (error) {
        log.debug(`   ⚠️ could not dial ${addr}: ${error.message}`);
      }
    }
    const dialed = reached.size;
    if (dialed === 0) {
      throw new Error(
        `Could not dial any provider for ${cid} (tried ${addrs.length})`,
      );
    }

    const read = cat ?? (await unixfsCat(helia));
    const parts = [];
    let total = 0;
    for await (const chunk of read(cid, { signal })) {
      parts.push(chunk);
      total += chunk.length;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    log.info(`   ✅ ${bytes.length} bytes over libp2p from ${dialed} peer(s)`);
    return bytes;
  };
}

/**
 * `@helia/unixfs` rather than the blockstore: a backup large enough to be
 * chunked is a DAG, and `blockstore.get` would return its root block and call
 * that the file. Imported here so a caller that supplies `cat` never loads it.
 */
async function unixfsCat(helia) {
  const [{ unixfs }, { CID }] = await Promise.all([
    import("@helia/unixfs"),
    import("multiformats/cid"),
  ]);
  const fs = unixfs(helia);
  return (cid, options) =>
    fs.cat(typeof cid === "string" ? CID.parse(cid) : cid, options);
}

/**
 * Try HTTP first, then peers — and say which one delivered.
 *
 * The order is not a preference for HTTP: a warm gateway answered in 0.23 s
 * against 0.86–1.9 s over libp2p, and a phone on a rationed connection should
 * not open a swarm for a file one request would have fetched. But the timeout
 * is short on purpose, because the other measurement from the same day is a
 * gateway taking 29 s for a block a peer served in under one.
 *
 * @param {Object} options
 * @param {(cid: string, options?: Object) => Promise<Uint8Array>} options.viaGateway
 * @param {(cid: string, options?: Object) => Promise<Uint8Array>} options.viaPeers
 * @param {number} [options.gatewayTimeout=3000] - before the peer path starts
 * @param {(path: "gateway"|"peers", info: Object) => void} [options.onPath] -
 *   told which path was taken and how long it took, so a page can show it
 * @returns {(cid: string, options?: Object) => Promise<Uint8Array>}
 */
export function createGatewayFirstFetch({
  viaGateway,
  viaPeers,
  gatewayTimeout = 3000,
  onPath = () => {},
  now = () => Date.now(),
} = {}) {
  return async function fetchBytes(cid, options = {}) {
    const started = now();
    try {
      const bytes = await viaGateway(cid, {
        ...options,
        timeout: gatewayTimeout,
      });
      onPath("gateway", { cid, ms: now() - started, bytes: bytes.length });
      return bytes;
    } catch (error) {
      const gatewayMs = now() - started;
      const peersStarted = now();
      try {
        const bytes = await viaPeers(cid, options);
        onPath("peers", {
          cid,
          ms: now() - peersStarted,
          bytes: bytes.length,
          after: { path: "gateway", ms: gatewayMs, error: error.message },
        });
        return bytes;
      } catch (peerError) {
        throw new Error(
          `Could not fetch ${cid}: the gateway said "${error.message}" and the peers said "${peerError.message}"`,
          { cause: peerError },
        );
      }
    }
  };
}
