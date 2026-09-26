# Getting a database back on a device that has nothing

A phone is lost. The one that replaces it has a security key in it and nothing
else: no backup file, no address, no account, no note with a CID on it. Can it
end up holding the same database, with the same identity, allowed to write?

Yes, and this is the whole procedure. It spans two packages, and neither of
them can do it alone.

## What has to be true

Four things, and each is a separate problem:

| | The problem | Where it is solved |
|---|---|---|
| **The data** | the database has to exist somewhere the new device can fetch it | `@le-space/orbitdb-storage-bridge/backup-car` — one CAR, one metadata file |
| **The name** | nobody can *tell* the new device a CID, so the location must be computable | `@le-space/orbitdb-storage-bridge/pointer-ipns` — an IPNS name derived from a secret |
| **The identity** | a restored copy is readable, but writing needs the *same* identity | `@le-space/orbitdb-identity-provider-webauthn-did` ≥ 0.6.0 — derived from the passkey, not stored |
| **The secret** | all three need one thing that survived the loss | the passkey's **PRF output**, which never leaves the authenticator's answer |

The last row is what makes the rest possible: the same security key, on any
device, answers the same PRF question with the same secret. Everything else is
derived from it.

## The procedure

### On the device that still has the database

```js
import { restoreIdentityFromAuthenticator } from '@le-space/orbitdb-identity-provider-webauthn-did'
import { dehydrate } from '@le-space/orbitdb-storage-bridge/dehydrate'
import { createAlephBackend } from '@le-space/orbitdb-storage-bridge/backends/aleph'

// Two touches of the passkey: the DID, and the signing key derived from the
// PRF output. Both are the same on any device holding this key.
const restored = await restoreIdentityFromAuthenticator()

await dehydrate({
  orbitdb,
  address: db.address,
  seed: restored.signingKey,      // the secret both devices can produce
  label: 'mesh-todo',             // one seed can name several databases
  backend: createAlephBackend(),  // upload without an account
})
```

`dehydrate` backs the database up as a CAR, uploads it with a metadata file
that names it, and publishes an IPNS record — signed by a key derived from the
seed — that points at that metadata. It returns the name the pointer lives
under, which nobody has to write down.

### On the device that has nothing

```js
import { restoreIdentityFromAuthenticator } from '@le-space/orbitdb-identity-provider-webauthn-did'
import { hydrate } from '@le-space/orbitdb-storage-bridge/dehydrate'
import { ALEPH_GATEWAYS } from '@le-space/orbitdb-storage-bridge/backends/aleph'

const restored = await restoreIdentityFromAuthenticator()   // same key, same DID

const { db, address } = await hydrate({
  orbitdb,                       // built with this identity — see below
  seed: restored.signingKey,
  label: 'mesh-todo',
  open: { sync: false },         // a node without pubsub needs this
  // The backup went to Aleph, and only Aleph has it the moment it lands. The
  // default list starts with Storacha's gateways and does not include Aleph's.
  restore: { gateways: ALEPH_GATEWAYS },
})
```

**Building that `orbitdb` with the passkey vouching**, as funkpost's recovery
page does, costs a third touch: OrbitDB's identity carries a signature by the
identity provider over the signing key, and the WebAuthn provider makes it with
the passkey. Since provider 0.7.0 the restore result carries the credential in
the shape the provider takes:

```js
import { Identities, createOrbitDB, useIdentityProvider } from '@orbitdb/core'
import { OrbitDBWebAuthnIdentityProviderFunction } from '@le-space/orbitdb-identity-provider-webauthn-did'

useIdentityProvider(OrbitDBWebAuthnIdentityProviderFunction)
const identities = await Identities({ ipfs: helia })   // `ipfs` — see the traps
const identity = await identities.createIdentity({
  provider: OrbitDBWebAuthnIdentityProviderFunction({
    webauthnCredential: restored.credential,
    signingKeyType: 'secp256k1',
  }),
})
const orbitdb = await createOrbitDB({ ipfs: helia, identity, identities })
```

Without that touch, the derived key can be the writer itself, through OrbitDB's
default `publickey` provider — the second trap below shows how to seed it.

`hydrate` derives the same key, asks the routing endpoints for the pointer,
**checks the record against the name it asked for**, fetches the metadata and
the CAR, puts every block into the local blockstore, and opens the database.

Writing works because the identity is the same one: `restoreIdentityFromAuthenticator`
recovers the DID from two signatures and derives the signing key from the PRF
output, so the access controller that named the original writer recognises this
device as that writer.

## Derived, not stored

Nothing about this procedure is kept anywhere except the two public objects —
the backup and the pointer — and neither of them is secret:

- **the signing key** is HKDF over the PRF output with the DID mixed in, so
  there is no key file, no encrypted archive, nothing to lose or leak;
- **the DID** is recovered from two ECDSA signatures rather than read from
  storage — an assertion does not carry the public key, but two of them admit
  exactly one;
- **the PRF input** is fixed per relying party (`…:prf:v2:<rpId>`), so both
  devices ask the authenticator the same question;
- **the pointer's name** is the hash of a key derived from the same seed, so
  both devices arrive at the same name without exchanging anything.

The seed handed to `dehydrate` above is the signing key rather than the PRF
output itself, because that is what the provider gives a caller: it is derived from
the PRF output with the DID mixed in, so it is equally reproducible and equally
secret, and `derivePointerKey` stretches it again under its own info string, so
the pointer key and the signing key never coincide. Anyone who could compute
the pointer name from it already holds the identity, so nothing is given away.

An earlier design in this family kept an encrypted identity archive next to the
backup. With a derived signing key there is nothing to put in it.

**And that is what makes the restored copy a writer rather than a reader.** The
device that comes back produces the same identity document — same id, same hash
— so the access controller that named the original writer accepts its entries.
Shown in `test/restored-can-write.test.js`: the restored device writes, the
entry crosses a courier, and the original takes it; a device holding another
key restores the same database, reads it, and is **refused** on write.

## Traps on the way

None of them announces itself. The first two cost an afternoon each in Node;
the last three turned up on 21 September, between the code and two phones.

**`Identities` without `ipfs` can only verify what it created itself.**
`Identities({ keystore })` keeps identity documents in memory, so a node
restoring somebody else's database drops every entry it cannot verify — and a
restored database is full of entries written by an identity this node has never
minted. The log comes back *empty*, with no error. Pass the Helia instance:

```js
const identities = await Identities({ keystore, ipfs: helia })
```

**Seeding a keystore under your own label is not enough** (with OrbitDB's
default `publickey` provider). `createIdentity({ id: 'label' })` resolves the
id to the *hex public key* of the key stored under `label`, and then looks for
a key under **that** hex id — generating a random one when it finds none. The
identity then differs on every device even though the seed does not. Seed both:

```js
await keystore.addKey(label, { privateKey: derived })
const seeded = await keystore.getKey(label)
await keystore.addKey(hex(seeded.publicKey.raw), { privateKey: derived })
```

The WebAuthn identity provider does not have this detour: its id is the DID and
it seeds the key under the DID.

**The credential id comes twice.** The provider wants it as text
(`credentialId`, written into the signature envelope) and as bytes
(`rawCredentialId`, sent to the key). Before provider 0.7.0,
`restoreIdentityFromAuthenticator` returned the bytes under `credentialId`, and
a page that passed them on as `rawCredentialId` gave the provider no text: the
third touch succeeded, then `sign()` threw — `Cannot read properties of
undefined (reading 'substring')`. Since 0.7.0, hand over `restored.credential`
as it is.

**Helia 7's `createHelia()` does not start the node**, and an `await` in front
of it looks as if it did. libp2p never runs, and the first block OrbitDB
stores fails with `Not started`. It also lays the options given over a default
stack — a DHT, delegated routing, public gateways. For a node that should stay
quiet, compose it and start it:

```js
const helia = withLibp2pLight(                     // from @helia/libp2p
  createHeliaLight({ blockstore, datastore, codecs: [dagCbor] }),
  { addresses: { listen: [] }, transports: [webSockets()],
    connectionEncrypters: [noise()], streamMuxers: [yamux()] },
)
await helia.start()   // returns nothing; keep `helia`
```

**Restore asks the gateways it is told.** The default list used to be from
before Aleph — `w3s.link` and `storacha.link`, then `dweb.link` and `ipfs.io` —
and every one of those was retired or redirected into a retirement by
2026-09-21. It is now Aleph's own gateway, which is where a fresh Aleph upload
is certain to be, and it is a list of one: if that host is unreachable from
where the phone is, the restore has nowhere else to ask. Pass
`restore: { gateways: [...] }` when you have somewhere better.

**Or skip the gateway.** `restoreFromCID` takes `fetchBytes`, and
`peer-fetch.js` builds one that goes over libp2p instead — bitswap from the
peers that hold the blocks. Measured from a real page on 2026-09-23: Pinata 0.73 s to
dial over `wss` and 0.26 s for the block, Lighthouse 0.58 s over
`webrtc-direct` and 0.32 s — and **no credential anywhere in it**, while both
providers' HTTP gateways want that account's key.

```js
import { createPeerFetch, createGatewayFirstFetch, PINATA_BITSWAP } from
  "@le-space/orbitdb-storage-bridge/peer-fetch";
import { fetchFromGateways } from "@le-space/orbitdb-storage-bridge/gateway-fetch";

const viaPeers = createPeerFetch({ helia, providers: [PINATA_BITSWAP] });

await hydrate({
  orbitdb, seed,
  restore: {
    // HTTP while it is warm — 0.2 s beats 1 s — and peers the moment it is not.
    fetchBytes: createGatewayFirstFetch({
      viaGateway: fetchFromGateways,
      viaPeers,
      gatewayTimeout: 3000,
      onPath: (path, info) => console.info(`${path} delivered in ${info.ms} ms`),
    }),
  },
});
```

Two things to know before wiring it up:

- **The Helia doing this needs bitswap**, and a fetch-only node wants
  `addresses: { listen: [] }` — Helia's browser defaults try to listen on
  `/webrtc` and `/p2p-circuit` and throw on start when no transport serves
  them.
- **Name the providers deliberately.** There is no default list, because a page
  that dials a service it never uploaded to is telling that service what its
  reader is looking for. `PINATA_BITSWAP` and `ALEPH_BITSWAP` are constants;
  `providersFor(cid)` asks a router for anyone else.
- **Which router knows what.** `cid.contact` is an IPNI index and answers a
  browser with CORS, but it does not know Aleph's CIDs — Aleph announces over
  the DHT, where only `delegated-ipfs.dev` looks, and that one sends no CORS
  header for provider lookups. So from a page, a lookup finds Pinata and
  Lighthouse, and Aleph is reached through its constant.

## What this does not promise

Say these out loud before building on it:

- **A pointer lives as long as the routing endpoints keep it.** Publication
  goes through delegated routing (`PUT /routing/v1/ipns/{name}`) because a
  browser cannot join the DHT. Measured against `delegated-ipfs.dev` on
  2026-09-19, from Node and from a browser page on a foreign origin: preflight
  204 with `PUT` allowed from any origin, `PUT` 200, `GET` 200 byte for byte.
  Whether the record travels beyond the endpoint that took it was **not**
  established — the public gateways answered 429 and 403 — and neither was how
  long it is kept. Publish to more than one endpoint where it matters.
- **A backup lives as long as the storage backend keeps it.** Aleph takes an
  upload without an account and keeps it without a promise; retention needs a
  wallet-signed STORE message. `createAlephBackend({ pin: createAlephPin({
  sender, sign }) })` gives the backend a `pinCid()` for that — but `dehydrate`
  does not call it: a caller that wants the backup kept pins the returned CIDs
  itself. Pinata and Lighthouse keep what their accounts pay for, and need a key
  a public page must not hold.
- **An update is not visible at once.** A second publish under the same name
  was still not being served six minutes later. Write a pointer once and read
  it back later, rather than treating it as shared mutable state.
- **A lost passkey is a lost database.** There is no recovery path around the
  authenticator, by design: the alternative is a secret sitting somewhere that
  is not the key.

## What was measured, and on what

- **The whole procedure, on two phones** — 2026-09-21, one YubiKey, through
  the [recovery page](https://nikrause.github.io/orbitdb-storage-bridge/recovery/). A
  Galaxy Fold 5 made a list and dehydrated it to Aleph, then was **reset**. A
  Galaxy A57 with the same key had the same DID and derived signing key,
  hydrated the list with the key alone, and **wrote an entry the access
  controller accepted**
  ([funkpost#93](https://github.com/NiKrause/funkpost/issues/93#issuecomment-5765768993)). The missing-PRF refusal was not repeated there; it is
  in the provider's tests. The identity-and-write half also runs on every
  funkpost PR, with a Chromium virtual authenticator that has PRF.
- **PRF travels, and so does the whole identity** — one YubiKey, a Galaxy
  Fold 5 and a Galaxy A57, 2026-09-19: the same PRF value, the passkey found
  without being named, ES256 signatures leaving exactly one candidate public
  key, and the same DID and derived signing key on both phones. The probe is
  [`passkey-probe`](https://le-space.github.io/orbitdb-identity-provider-webauthn-did/passkey-probe/), and it
  deliberately implements none of this from the packages, so it can disprove
  them.
- **A browser may publish a pointer** — `test/helpers/probe-ipns-routing.js`,
  same date, numbers above.
- **The round trip works without a network** — `test/dehydrate.test.js` backs a
  database up on one node and brings it back on another, through a memory
  backend and a routing endpoint written in the test file, with nothing between
  the two but the seed.

## Where the pieces live

- `@le-space/orbitdb-storage-bridge/dehydrate` — `dehydrate()`, `hydrate()`
- `@le-space/orbitdb-storage-bridge/pointer-ipns` — `derivePointerKey()`,
  `publishPointer()`, `resolvePointer()`
- `@le-space/orbitdb-storage-bridge/backup-car`, `/restore-cid` — the CAR and the
  metadata underneath
- `@le-space/orbitdb-identity-provider-webauthn-did` —
  `restoreIdentityFromAuthenticator()` (0.7.0: `restored.credential`), `recoverPublicKey()`,
  `prfInputForRelyingParty()`, `deriveSigningKeyBytes()`

The phase this was built for is **P11** in
[funkpost's roadmap](https://github.com/NiKrause/funkpost/blob/main/ROADMAP.md):
*the device is gone, the internet brings it back.*
