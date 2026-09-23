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
 * Aleph's own node, which took some finding.
 *
 * It publishes no `_dnsaddr` and answers `404` to `/api/v0/id`, so looking for
 * it the way Pinata is found says it has no peer — which is what an earlier
 * version of this file claimed. It does: ask a router for the providers of a
 * CID Aleph holds, and the record is `46.255.204.211`, the address
 * `ipfs.aleph.cloud` resolves to, with `webrtc-direct` and `webtransport`
 * among its addresses. A page dialled it in 450 ms and had the block 345 ms
 * later.
 *
 * Two caveats make this a starting point rather than a guarantee:
 *
 * - **The certhash rotates.** A `webrtc-direct` address carries the
 *   certificate's hash, and the node generates a new certificate when it
 *   restarts. When this address stops working, look the CID up again — the
 *   peer id is the stable part.
 * - **Only one router will tell you.** Aleph announces over the DHT rather
 *   than IPNI, so `cid.contact` — the one router that answers a browser with
 *   CORS — does not know its CIDs, while `delegated-ipfs.dev` does and sends
 *   no CORS header for provider lookups. From a page, this constant is the way
 *   in; from Node, {@link providersFor} with `delegated-ipfs.dev` is better.
 */
export const ALEPH_BITSWAP = Object.freeze([
  "/ip4/46.255.204.211/udp/4001/webrtc-direct/certhash/uEiCbM9yMfnP02vviIL26n8bI0-vU0DGUHx20POBLKGjEmg/p2p/12D3KooWACE5dRw5V9WXuDTcngjE3ZaDSZ4qYJGfuhXZbENnL54y",
  "/ip4/46.255.204.211/udp/4001/quic-v1/webtransport/certhash/uEiDMxOK9kZFH5SW6zcmNpXU4EGgBgvZYqqlJhw1cci50KA/certhash/uEiCeRpuyQWojWx2cP8guNiY3EDfIF25D2k8CMTZd1qtSfw/p2p/12D3KooWACE5dRw5V9WXuDTcngjE3ZaDSZ4qYJGfuhXZbENnL54y",
]);

/** Aleph's peer id, which outlives the certificate hashes above. */
export const ALEPH_PEER_ID = "12D3KooWACE5dRw5V9WXuDTcngjE3ZaDSZ4qYJGfuhXZbENnL54y";

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
  if (!BROWSER_TRANSPORTS.some((transport) => addr.includes(transport))) return false;
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
 * @returns {Promise<Array<{ id: string, addrs: string[] }>>}
 */
export async function providersFor(cid, {
  routers = DEFAULT_ROUTERS,
  dialableOnly = true,
  signal = null,
  fetchImpl = fetch,
  log = SILENT,
} = {}) {
  const found = new Map();

  for (const router of routers) {
    try {
      const response = await fetchImpl(`${router}/routing/v1/providers/${cid}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        log.debug(`   ⚠️ ${router} answered ${response.status}`);
        continue;
      }
      const body = await response.text();
      for (const record of parseProviderRecords(body)) {
        const id = record.ID ?? record.id;
        if (!id) continue;
        const addrs = (record.Addrs ?? record.addrs ?? []).filter(
          (addr) => !dialableOnly || isBrowserDialable(addr),
        );
        if (addrs.length === 0) continue;
        const already = found.get(id);
        if (already) {
          for (const addr of addrs) if (!already.addrs.includes(addr)) already.addrs.push(addr);
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
    const signal = options.signal ?? AbortSignal.timeout(options.timeout ?? timeout);
    const addrs =
      typeof providers === "function" ? await providers(cid) : [...providers];

    if (addrs.length === 0) {
      throw new Error(`No provider to dial for ${cid}`);
    }

    const dialOne = dial ?? (async (addr) => {
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
      throw new Error(`Could not dial any provider for ${cid} (tried ${addrs.length})`);
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
  return (cid, options) => fs.cat(typeof cid === "string" ? CID.parse(cid) : cid, options);
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
      const bytes = await viaGateway(cid, { ...options, timeout: gatewayTimeout });
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
