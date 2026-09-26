# Storacha Svelte Components

This document provides detailed documentation for the Svelte components included in the OrbitDB Storage Bridge project for browser-based integration.

## Table of Contents

- [Storacha Svelte Components](#storacha-svelte-components)
  - [Table of Contents](#table-of-contents)
  - [Component Overview](#component-overview)
  - [StorachaAuth.svelte](#storachaauthsvelte)
  - [StorachaTest.svelte](#storachatestsvelte)
  - [StorachaTestWithReplication.svelte](#storachatestwithreplicationsvelte)
  - [StorachaTestWithWebAuthn.svelte](#storachatestwithwebauthnsvelte)
  - [WebAuthnDIDProvider.js](#webauthndidproviderjs)
  - [StorachaIntegration.svelte](#storachaintegrationsvelte)
  - [Svelte App Demos](#svelte-app-demos)
  - [Live Demo](#live-demo)
  - [Return to Main Documentation](#return-to-main-documentation)

## Component Overview

The OrbitDB Storage Bridge project includes **Svelte components** for browser-based demos and integration. These components provide various authentication methods, backup/restore functionality, and P2P replication capabilities.

The three test harnesses — `StorachaTest.svelte`, `StorachaTestWithReplication.svelte` and `StorachaTestWithWebAuthn.svelte` — are **not in the npm package**. They are Storacha-only demos, and no published version could import them: each imports `./orbitdb-storacha-bridge`, a file the package never contained. The example apps started from copies of the replication and WebAuthn harnesses and have since moved on: they import the bridge by its package name and back up to Aleph, Pinata or Lighthouse.

Where this browser side came from, what it could do, and where every piece of it lives today — including the UCAN delegation work, which is on a branch — is recorded in [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md).

## StorachaAuth.svelte

**Location:** [`src/components/StorachaAuth.svelte`](src/components/StorachaAuth.svelte)

Authentication component supporting multiple Storacha authentication methods:

- Storacha credentials (Storacha-Key and Storacha Proof)
- UCAN authentication (delegated UCAN + corresponding temporary private key)
- WebAuthN/Passkey (P-256) UCANs and delegation (planed)

## StorachaTest.svelte

**Location:** [`src/components/StorachaTest.svelte`](src/components/StorachaTest.svelte) (repository only, not in the npm package)

Basic backup/restore demo with Alice & Bob using independent OrbitDB instances:

- Creates separate OrbitDB databases with different addresses
- No P2P replication - data exchange via Storacha backup/restore only
- Demonstrates entry-only backup approach (recreates database from entries + config)
- Uses mnemonic seed generation and DID-based identity management

## StorachaTestWithReplication.svelte

**Location:** [`src/components/StorachaTestWithReplication.svelte`](src/components/StorachaTestWithReplication.svelte) (repository only, not in the npm package). The example app started from a copy and has since moved on: [`ReplicationDemo.svelte`](examples/svelte/orbitdb-replication/src/lib/ReplicationDemo.svelte) backs up to Aleph, Pinata or Lighthouse.

Advanced replication demo with Alice & Bob using shared database and P2P connectivity:

- Creates shared OrbitDB database with same address for both peers
- Full P2P replication via libp2p with circuit relay support  
- Backup/restore preserves replication capabilities
- Uses Carbon Design System components for enhanced UI

## StorachaTestWithWebAuthn.svelte

**Location:** [`src/components/StorachaTestWithWebAuthn.svelte`](src/components/StorachaTestWithWebAuthn.svelte) (repository only, not in the npm package). The example app started from a copy and has since moved on: [`BackupRestoreDemo.svelte`](examples/svelte/simple-backup-restore/src/lib/BackupRestoreDemo.svelte) backs up to Aleph, Pinata or Lighthouse.

WebAuthn biometric authentication demo with hardware-secured DID identities:

- WebAuthn biometric authentication (Face ID, Touch ID, Windows Hello, PIN)
- Hardware-secured DID creation using WebAuthn credentials
- CBOR public key parsing from WebAuthn attestation objects
- Backup/restore with biometric-secured identities

## WebAuthnDIDProvider.js

**Location:** [`src/components/WebAuthnDIDProvider.js`](src/components/WebAuthnDIDProvider.js)

WebAuthn DID Provider for OrbitDB - Complete identity provider implementation:

- WebAuthn integration with OrbitDB's identity system
- Public key extraction from WebAuthn credentials via CBOR parsing
- DID specification compliance (`did:webauthn:...` format)
- Hardware-secured private keys that never leave the secure element
- Biometric authentication for every signing operation

## StorachaIntegration.svelte

**Location:** [`src/components/StorachaIntegration.svelte`](src/components/StorachaIntegration.svelte)

Full integration component for existing OrbitDB Svelte applications:

- Hash and identity preserving backup/restore (full database reconstruction)
- Progress tracking with real-time upload/download indicators
- LocalStorage credential management with auto-login
- Space management (create, list, select Storacha spaces)
- Note: Currently has browser limitations for full hash preservation ([Issue #4](../../issues/4))

## Svelte App Demos

In the examples/svelte diretory you find three simple to advanced OrbitDB-Storacha examples.

- simple-backup-restore (Alice creates a db and backs it up to Aleph, Pinata or Lighthouse - Bob restores it into his own - no replication)
- orbitdb-replication (Alice and Bob replicate one database through a relay, and back it up to Aleph, Pinata or Lighthouse; both may write)
- ucan-delegation (P-256 UCAN's were not supported by Storacha's upload service; the example left the mainline on 2025-11-23 and lives on the branch [`feature/ucan-delegation-example`](https://github.com/NiKrause/orbitdb-storage-bridge/tree/feature/ucan-delegation-example/examples/svelte/ucan-delegation) — see [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md))

## Live Demo

- The Storacha widget is no longer part of the Simple Todo example: that app removed Storacha on 2026-05-27, deleting the original component this package's copy came from. The app still runs at [simple-todo.le-space.de](https://simple-todo.le-space.de/), without it. See [docs/STORACHA-UI-HISTORY.md](docs/STORACHA-UI-HISTORY.md).

---

### Simple Backup & Restore Live Demo

[![Simple Backup & Restore Demo](https://img.youtube.com/vi/Bzeg5gHlQvE/maxresdefault.jpg)](https://www.youtube.com/watch?v=Bzeg5gHlQvE)

**Watch on YouTube:** [Simple Backup & Restore Demo →](https://www.youtube.com/watch?v=Bzeg5gHlQvE)

---

### OrbitDB Replication Live Demo

[![OrbitDB Replication Demo](https://img.youtube.com/vi/ZOYeMIiVwr8/maxresdefault.jpg)](https://www.youtube.com/watch?v=ZOYeMIiVwr8)

**Watch on YouTube:** [OrbitDB Replication Demo →](https://www.youtube.com/watch?v=ZOYeMIiVwr8)

## Return to Main Documentation

[← Back to README](README.md)
