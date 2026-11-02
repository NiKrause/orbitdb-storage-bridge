# What a quantum computer would, and would not, break here

"Is this quantum proof?" has no answer for a system, only for a layer. This package has
layers that are in good shape and layers that are not, and they fail in different directions:
the part that keeps a backup secret would hold, and the part that says who wrote it would not.

Written 2026-11-02 against the code as it then stood. Every algorithm is named so the claims
can be rechecked rather than believed, and the reasoning below is textbook — this is a reading
of this repository, not a cryptographic review.

## What is actually used

| | | |
| --- | --- | --- |
| the data | **AES-256-GCM**, 12-byte IV | [`lib/backends/encryption.js`](../lib/backends/encryption.js) |
| its key | **HKDF-SHA-256** over the PRF output | the consumer's, e.g. `examples/svelte/recovery/src/stack.js` |
| the PRF | **HMAC-SHA-256** inside the authenticator (CTAP2 `hmac-secret`) | the security key itself |
| log entries | **secp256k1** | the OrbitDB identity |
| the pointer | **Ed25519** | [`lib/pointer-ipns.js`](../lib/pointer-ipns.js) |
| the credential | **ES256**, i.e. P-256 | WebAuthn, `pubKeyCredParams: [{ alg: -7 }]` |
| every CID | **SHA-256** | content addressing throughout |

## Reading the data: holds

PRF → HKDF → AES is symmetric all the way down. Grover halves the exponent, so a 256-bit key
is worth about 2¹²⁸ against a quantum search — and Grover parallelises badly, so the advantage
erodes further the more machines are thrown at it. This is why NIST treats AES-256 as adequate
for the post-quantum era, and why 256 rather than 128 is the choice that matters.

It matters more here than in most places. **The ciphertext is in a public network by design.**
"Harvest now, decrypt later" is not a hypothesis for us — anyone can fetch the file today and
keep it. So the symmetric layer carries the whole weight of confidentiality, and it is the
layer that holds.

## Restoring the right data: holds, and not for the reason one expects

A forged pointer is within reach of a quantum adversary: IPNS records are Ed25519, and the
record publishes the public key the name is a hash of. So assume one: your second device asks
for the pointer under your name and is handed somebody else's CID.

It gets a decryption failure, not a poisoned list.

```
The backup at <cid> is not encrypted. A sealed backup never comes back as plaintext …
Could not decrypt the backup at <cid>: … It was written with a different key …
```

`decryptingFetch` refuses plaintext outright and fails closed when the AES-GCM tag does not
verify. **What makes a restore trustworthy here is the AEAD tag, not the pointer's signature**
— and the tag is symmetric. An adversary who can forge every signature in the system still
cannot produce bytes this device will open, because that needs the key.

Two things follow, and the second is a warning:

- Do not add a shortcut that trusts the pointer instead of the envelope. The property above is
  load-bearing and easy to lose by accident.
- **`allowPlaintextReads: true` turns the gate off.** It exists to read backups written before
  0.19.0, and a consumer that leaves it on inherits exactly the weakness the signatures have.

## Writing: falls

Everything that signs is broken by Shor:

- **Log entries (secp256k1).** The access controller admits an entry on its signature, so a
  forger writes as you. In a database that replicates live, that is the whole attack.
- **The chain behind it.** The credential (P-256) vouches for the signing key (secp256k1),
  which signs the entries. Shor breaks both links, so neither rescues the other.
- **The pointer (Ed25519).** Harmless against a sealed backup, as above — but a redirect is
  still a denial of the right answer, and it is not harmless for anyone reading plaintext.
- **Aleph's `STORE` and `FORGET`** are signed by a wallet key. Forging a `FORGET` releases the
  pins on your files: an availability attack rather than a disclosure.

So: confidentiality survives, **authorship does not**. For a recovery story that is the more
uncomfortable half, because "the list accepts it because it is still you" is a claim about a
signature.

## The narrow one: the link to the key

The PRF value does not live in the browser — it is asked for over CTAP2, and that channel is
built with **ECDH over P-256**. Someone who recorded that exchange could break it later and
obtain the data key itself. It needs physical presence at the time, over USB, NFC or Bluetooth,
which is a far narrower threat than recorded network traffic. It is also the only place where
the symmetric key depends on a classical key agreement, which is why it is worth naming.

## In transit

TLS to the gateways and libp2p's Noise handshake (X25519) are classically breakable later. It
costs nothing here, because the payload is already sealed before it goes anywhere — the one
place where encrypting before upload pays twice.

Note the asymmetry with **live replication**: entries moving between peers are protected by the
transport and by nothing else unless the application encrypts them itself. Recorded replication
traffic is therefore exposed to harvest-now-decrypt-later in a way the backups are not.

## What to do

Little, today, and honestly: **there is no post-quantum signature in OrbitDB, libp2p or IPNS.**
ML-DSA is standardised and nothing in this stack speaks it. That is an upstream matter, not one
the bridge can fix.

What is in our hands is already mostly done, and worth not undoing:

- AES-256 rather than AES-128.
- A separate key for the backup, derived from the same secret under its own info string, so a
  compromised backup key is not a signing key.
- The restore gated on the AEAD rather than on a signature.
- Detection where prevention is impossible: every block is checked against its own CID, the
  manifest must match the address it claims, and the DID fingerprint on screen is there so two
  devices can be compared by a human.

If the question is which way to watch, watch the signatures. The encryption is not where this
will go wrong.
