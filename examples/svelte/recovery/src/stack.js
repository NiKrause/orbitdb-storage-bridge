// SPDX-License-Identifier: MIT
/* global location, indexedDB */
/**
 * The stack this page needs, and nothing else.
 *
 * P11 asks one question — *can a device that has lost everything get the list
 * back, with the same identity, allowed to write?* — so everything here is
 * arranged to answer it and to be visibly incapable of cheating:
 *
 *   · **no network path between the phones.** libp2p listens nowhere, there is
 *     no relay, no pubsub, no discovery and no sync. The one thing it dials is
 *     the provider that holds the backup — a single address, named in the
 *     code — so a block can come back when the gateway will not serve it.
 *     Nothing about that lets the two devices find each other: what crosses
 *     between them still crosses as a backup and a pointer, or not at all.
 *   · **nothing stored that matters.** The identity is derived from the
 *     security key every time. The database lives in an in-memory blockstore,
 *     so "forget everything" is a reload away from being true.
 *
 * The procedure itself is the bridge's, written up in
 * https://github.com/NiKrause/orbitdb-storage-bridge/blob/main/docs/RECOVERY-ON-A-SECOND-DEVICE.md
 */
import { createHeliaLight } from "helia";
import { withLibp2pLight } from "@helia/libp2p";
import { withBitswap } from "@helia/bitswap";
import * as dagCbor from "@ipld/dag-cbor";
import { webSockets } from "@libp2p/websockets";
import { webRTCDirect } from "@libp2p/webrtc";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { MemoryBlockstore } from "blockstore-core";
import { MemoryDatastore } from "datastore-core";
import {
  createOrbitDB,
  Identities,
  useIdentityProvider,
  IPFSAccessController,
} from "@orbitdb/core";
import {
  restoreIdentityFromAuthenticator,
  OrbitDBWebAuthnIdentityProviderFunction,
} from "@le-space/orbitdb-identity-provider-webauthn-did";
import { dehydrate, hydrate } from "@le-space/orbitdb-storage-bridge/dehydrate";
import { fetchFromGateways } from "@le-space/orbitdb-storage-bridge/gateway-fetch";
import { createBackendFromChoice } from "@le-space/orbitdb-storage-bridge/backends/choose";
import {
  createPeerFetch,
  createGatewayFirstFetch,
  providersFor,
  ALEPH_BITSWAP,
  PINATA_BITSWAP,
} from "@le-space/orbitdb-storage-bridge/peer-fetch";
import { createAlephBackend, ALEPH_GATEWAYS } from "@le-space/orbitdb-storage-bridge/backends/aleph";

/** One label for this demo's pointer, so one key can name other things too. */
export const LABEL = "funkpost-recovery-demo";
const DATABASE_NAME = "recovery-demo";

/**
 * Ask the security key who this is.
 *
 * Two touches: the first reads the PRF value with the PIN, the second signs
 * again so the public key — which an assertion does not carry — can be
 * recovered from the pair. Returns the DID, the derived signing key, and the
 * credential the OrbitDB identity provider takes as it is (since 0.7.0 of the
 * provider; before, the page had to build it, and got it wrong once).
 */
export async function identityFromKey({ onTouch } = {}) {
  const restored = await restoreIdentityFromAuthenticator({
    rpId: location.hostname,
    onTouch,
  });
  return {
    did: restored.did,
    signingKey: restored.signingKey,
    credential: restored.credential,
  };
}

/**
 * Helia and OrbitDB, with the passkey's identity.
 *
 * The identity provider derives the signing key from the PRF output and binds
 * it to the DID, which costs one more touch of the key the first time.
 */
export async function createStack({ credential }) {
  // Composed and started, as mesh-todo does it. Helia 7's createHelia() does
  // neither: it returns a node that was never started — the first block
  // OrbitDB stored then failed with "Not started" — and it lays the options
  // over its default stack, with a DHT, delegated routing and public gateways.
  // Composed rather than createHelia(), as mesh-todo does it: createHelia
  // returns a node that was never started, and lays the options over a default
  // stack with a DHT, delegated routing and public gateways.
  //
  // Bitswap is here for one job — fetching the backup from the peer that holds
  // it when the gateway will not (#127). It cannot sync the database: that is
  // opened with `sync: false`, and there is nobody to sync with anyway.
  const helia = await withBitswap(
    withLibp2pLight(
      createHeliaLight({
        blockstore: new MemoryBlockstore(),
        datastore: new MemoryDatastore(),
        codecs: [dagCbor],
      }),
      {
        // Listening nowhere is still the point: nothing can reach this page,
        // and it announces nothing.
        addresses: { listen: [] },
        // webRTCDirect because that is what Aleph's node answers on — it has
        // no wss address at all. webSockets stays for providers that do.
        transports: [webSockets(), webRTCDirect()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        // Bitswap needs identify, and `withLibp2pLight` does not bring it.
        // Without it the dial succeeds, the peer is never recognised as
        // speaking bitswap, no want is sent, and the fetch times out with
        // "Failed to load block" — measured: 60 s of nothing, against 1.6 s
        // for 400 kB once identify is there.
        services: { identify: identify() },
      },
    ),
  ).start();

  useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction);
  // `ipfs`, so identity documents are blocks: a restored database is full of
  // entries by an identity this device never minted, and without it they
  // cannot be verified — the log would come back empty and say nothing.
  const identities = await Identities({ ipfs: helia });
  const identity = await identities.createIdentity({
    provider: OrbitDBWebAuthnIdentityProviderFunction({
      webauthnCredential: credential,
      signingKeyType: "secp256k1",
    }),
  });

  const orbitdb = await createOrbitDB({
    ipfs: helia,
    identity,
    identities,
    directory: `./recovery-${identity.id.slice(-8)}`,
  });
  return { helia, orbitdb, identity };
}

/** A list only this identity may write to. */
export async function createList({ orbitdb, identity }) {
  return orbitdb.open(DATABASE_NAME, {
    type: "events",
    sync: false, // there is no path to sync over, by design
    AccessController: IPFSAccessController({ write: [identity.id] }),
  });
}

/**
 * The services this page can put a backup on.
 *
 * Aleph needs nothing, which is why it is the one that is always available:
 * its ingest takes a blob from a page with no account at all. The other two
 * are the reader's own — their key, their account's gateway — and the page
 * holds neither unless they are typed in.
 */
export const SERVICES = Object.freeze([
  { id: "aleph", needsKey: false, needsGateway: false },
  { id: "pinata", needsKey: true, needsGateway: true },
  { id: "lighthouse", needsKey: true, needsGateway: true },
]);

/**
 * Turn what the reader ticked into a backend.
 *
 * One service is that driver; several are a mirror that writes to all of them
 * and reports what each one did — a backup that claims success while one
 * service quietly failed is the one answer that is not acceptable, and the
 * bridge's `createMirrorBackend` is built around that.
 *
 * @param {Array<{id: string, key?: string, gateway?: string}>} chosen
 */
export async function backendFor(chosen) {
  const services = chosen.filter((s) => SERVICES.some((known) => known.id === s.id));
  if (services.length === 0) {
    throw new Error("Pick at least one place for the backup");
  }

  const kind = services.map((s) => s.id);
  const gateway = Object.fromEntries(
    services.filter((s) => s.gateway).map((s) => [s.id, s.gateway]),
  );
  const pinata = services.find((s) => s.id === "pinata");
  const lighthouse = services.find((s) => s.id === "lighthouse");

  return createBackendFromChoice({
    kind: kind.length === 1 ? kind[0] : kind,
    ...(pinata?.key ? { jwt: pinata.key } : {}),
    ...(lighthouse?.key ? { apiKey: lighthouse.key } : {}),
    // The reader minted the key themselves, which is what makes it safe for a
    // page to hold — and what the driver reports as `browserSafeAuth`.
    keyOwnership: "user",
    // A gateway belongs to the service it came from: Pinata's answers 401 for
    // content it does not hold, Lighthouse's 402. With several services the
    // bridge refuses a single string, which is why this is a map.
    ...(Object.keys(gateway).length > 0
      ? { gateway: kind.length === 1 ? Object.values(gateway)[0] : gateway }
      : {}),
  });
}

/** Back the list up and publish the pointer the key's own secret names. */
export async function backUp({ orbitdb, address, signingKey, services = [{ id: "aleph" }] }) {
  return dehydrate({
    orbitdb,
    address,
    seed: signingKey,
    label: LABEL,
    backend: await backendFor(services),
  });
}

/** Gateways retired on 2026-09-21: they answer 429 with a Sunset header. */
const RETIRED = ["dweb.link", "ipfs.io", "w3s.link", "storacha.link"];
const isStillServing = (gateway) => !RETIRED.some((host) => gateway.includes(host));

/**
 * The two ways the backup can come back, and how they are chosen.
 *
 * `"first"` — the default — asks the gateway with a short timeout and falls
 * through to the peers when it does not answer. The order is measured, not a
 * preference: a warm gateway answered in 0.1 s from this page, against about a
 * second over libp2p. The timeout is short for the other measurement from the
 * same day, when a gateway took 29 s for a block a peer served in under one.
 *
 * `"gateway"` and `"p2p"` force one path, so a run can measure it alone, and
 * `"race"` starts both and takes whichever arrives — at the cost of doing the
 * work twice, which is why it is not the default on a phone.
 */
export const FETCH_PATHS = ["first", "gateway", "p2p", "race"];

/**
 * Find the pointer with the key alone, and open what it points at.
 *
 * @param {object} params
 * @param {object} params.orbitdb
 * @param {object} params.helia - the same node, for the peer path
 * @param {Uint8Array} params.signingKey
 * @param {Array<{id: string, gateway?: string}>} [params.services] - where the
 *   backup was put; the peers dialled follow from it and from nothing else
 * @param {"first"|"gateway"|"p2p"|"race"} [params.path]
 * @param {(path: "gateway"|"peers", info: object) => void} [params.onPath] -
 *   which way each object arrived, and how long it took, so the page can say so
 */
export async function bringBack({
  orbitdb,
  helia,
  signingKey,
  services = [{ id: "aleph" }],
  path = "first",
  onPath = () => {},
}) {
  const chose = (id) => services.some((s) => s.id === id);
  const ownGateway = services.find((s) => s.gateway)?.gateway;

  // The reader's own account gateway first, where they gave one — since the
  // public path gateways were retired that is the one they can rely on.
  const gateways = [
    ...(ownGateway ? [`${ownGateway.replace(/\/+$/, "")}/ipfs`] : []),
    ...(chose("aleph") ? ALEPH_GATEWAYS.filter(isStillServing) : []),
  ];

  const viaGateway = async (cid, options = {}) => {
    const started = Date.now();
    const bytes = await fetchFromGateways(cid, { ...options, gateways });
    onPath("gateway", { cid, ms: Date.now() - started, bytes: bytes.length });
    return bytes;
  };

  /**
   * Who to dial, decided by where the backup was put and by nothing else.
   *
   * Aleph and Pinata publish their bitswap endpoints, so those are constants —
   * Aleph's over the DHT, which is why only `delegated-ipfs.dev` knows its
   * CIDs, and Pinata's in DNS. Lighthouse publishes no name, so its node has
   * to be looked up per CID; for a backup written minutes ago the provider
   * that answers is the service it was written to.
   *
   * Aleph's webrtc certhash changes when that node restarts. Then this path
   * fails and the gateway carries the restore, which is the arrangement
   * working rather than breaking.
   */
  const providers = async (cid) => {
    const addrs = [];
    if (chose("aleph")) addrs.push(...ALEPH_BITSWAP);
    if (chose("pinata")) addrs.push(PINATA_BITSWAP);
    if (chose("lighthouse")) {
      const found = await providersFor(cid).catch(() => []);
      addrs.push(...found.flatMap((provider) => provider.addrs));
    }
    return addrs;
  };

  const peers = createPeerFetch({ helia, providers });
  const viaPeers = async (cid, options = {}) => {
    const started = Date.now();
    const bytes = await peers(cid, options);
    onPath("peers", {
      cid,
      ms: Date.now() - started,
      bytes: bytes.length,
      // Peers, not connections: one provider can answer on two transports, and
      // "2 peers" for one node is a lie the page should not tell.
      connections: new Set(
        helia.libp2p.getConnections().map((c) => c.remotePeer.toString()),
      ).size,
    });
    return bytes;
  };

  const fetchBytes =
    path === "gateway"
      ? viaGateway
      : path === "p2p"
        ? viaPeers
        : path === "race"
          ? (cid, options) => Promise.any([viaGateway(cid, options), viaPeers(cid, options)])
          : createGatewayFirstFetch({ viaGateway, viaPeers, gatewayTimeout: 3000 });

  return hydrate({
    orbitdb,
    seed: signingKey,
    label: LABEL,
    open: { sync: false },
    restore: { fetchBytes },
  });
}

/**
 * Forget everything this device holds: the blocks are in memory anyway, and
 * the keystore and identities are not. A reload then has nothing left to find.
 */
export async function forgetEverything() {
  try {
    localStorage.clear();
  } catch {
    // a browser that refuses storage has nothing to forget
  }
  const databases = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    databases
      .filter((database) => database.name)
      .map(
        (database) =>
          new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(database.name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          }),
      ),
  );
}
