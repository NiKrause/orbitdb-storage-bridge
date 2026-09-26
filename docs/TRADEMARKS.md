# Trademarks, and the licence line behind the seam

LoRa® is a trademark of Semtech Corporation. Meshtastic® is a registered
trademark of Meshtastic LLC. Other names used here — OrbitDB, IPFS, Filecoin,
Storacha, Pinata, Lighthouse, Aleph — belong to their respective owners and
appear only to say what this package interoperates with. This project is not
affiliated with or endorsed by any of them.

The first two appear in this repository only in prose about what the courier
seam is *for*: `courier-sync` is transport-neutral and this package contains no
code from either project and depends on neither. That is deliberate rather than
incidental. The Meshtastic client libraries (`@meshtastic/core`,
`@meshtastic/transport-web-bluetooth`) are **GPL-3.0-only**, and the courier
that drives them lives in [funkpost](https://github.com/NiKrause/funkpost), on
the GPL side of that line. This package is MIT and stays that way; the door
only opens one way.
