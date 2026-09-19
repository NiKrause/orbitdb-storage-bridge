# Storacha scripts, kept for reference

These scripts were written against Storacha, whose uploads stopped working in
May 2026. They are here rather than deleted because the code still shows how
the UCAN delegation flow worked, and because the reading half — gateways — is
still up. **None of them runs end to end today.**

| script | what it did | what replaced it |
|---|---|---|
| `ucan-demo.js` | backup and restore over a UCAN delegation | `../demo.js`, with a backend |
| `simple-ucan-auth.js` | authenticate with an existing delegation | — |
| `create-proper-ucan.js` | mint a delegation from key + proof | — |
| `test-ucan-bridge.js` | the bridge class under UCAN auth | — |
| `test-ucan-list.js` | list a space's uploads over UCAN | `backend.list()` on Pinata or Lighthouse |
| `ucan-revocation-demo.js` | revoke a delegation | — |
| `clear-space.js` | empty a Storacha space | `backend.remove()` |
| `car-backup-demo.js` | CAR backups, found by listing the space | `../backup-demo.js` — every backup is a CAR now, and its CID is the pointer |
| `timestamped-backup-example.js` | pick a backup out of a space listing | keep the CIDs, or list with a backend that can (`listing` capability) |
| `simple-todo-restore-demo.js` | restore a simple-todo database via a relay | `../restore-demo.js`; its relay address is also long gone |

What they all have in common is Storacha's model: a *space* you authenticate
into, that you can list and clear. The backends this library speaks to now are
narrower — Aleph takes an upload and hands back a CID, and nothing more — so
the restore path takes a CID rather than a space.

The Storacha driver itself is still shipped
(`@le-space/orbitdb-storage-bridge/backends/storacha`), and the gateway reads it does
still work. It is the uploads that do not.
