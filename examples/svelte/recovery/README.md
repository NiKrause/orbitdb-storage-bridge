# Recovery on a second device

A list, a security key, and a device that has lost everything. The page runs the procedure in
[docs/RECOVERY-ON-A-SECOND-DEVICE.md](../../../docs/RECOVERY-ON-A-SECOND-DEVICE.md) in a phone's
browser: the passkey gives the identity, `dehydrate` backs the list up and publishes an IPNS pointer
under a name derived from the key, and on another device the same key finds that pointer — so
`hydrate` needs no CID, no address and no file. The restored list takes new entries, because the
writer is the same.

Seven steps, in the order the test runs them, each saying what it proved rather than only that it
worked. The DID fingerprint on screen is what two phones are compared by: if it differs, nothing
that follows means anything, and the page says so. Nothing crosses between the devices but the
backup and the pointer: libp2p listens nowhere, there is no relay, no pubsub and no sync, and the
one address it dials is the provider that holds the backup. The database lives in memory, so
"forget everything" is a reload away from being true.

The page is published at
[nikrause.github.io/orbitdb-storage-bridge/recovery/](https://nikrause.github.io/orbitdb-storage-bridge/recovery/)
by `pages.yml`. On 21 September 2026 it ran on two phones: a Galaxy Fold 5 backed up and was reset,
and a Galaxy A57 with the same key brought the list back and wrote to it.

## Running it

The example uses the library in this checkout (`file:../../../`), so install the repository root
first:

```sh
npm install                               # in the repository root
cd examples/svelte/recovery
npm install
npm run dev
```

`npm run build` writes a static site to `build/`; `npm run preview` serves it.

## Where backups go

Aleph, Pinata or Lighthouse, ticked on the page; several at once go through a mirror. A gateway
belongs to one service, so with several chosen the page hands the bridge a map, never one string.
A key stays in the tab's memory and is sent from the browser, so use one you can revoke.

## Tests

```sh
npm test            # offline: what a tick turns into, as the backend the bridge is handed
npm run test:e2e    # Playwright, with a virtual security key (CTAP2, PRF)
```

The end-to-end test asks the virtual key for an identity, binds it to OrbitDB, makes a list and
writes to it — the path the phones took and fell off on 21 September, at the third touch. The
backup and the pointer need a public network and are not in it.

Debug logs: `localStorage.setItem('debug', 'libp2p:orbitdb-storacha:*')`.
