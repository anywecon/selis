# ADR 0014 — Trusted devices and library move (P3b)

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0010 (protocol), ADR 0011 (device key)

## Context

After a first transfer (QR code + 6-digit code), sending again to the same device should take
one tap, and moving everything to a new phone should be one action. Both must keep the P3a
guarantees: no account, nothing listening outside the Transfer screen, end-to-end encryption,
the user decides who may connect.

## Decision

### Trust

- After a confirmed transfer the done card offers **"Save this device"** (a name; the other
  device's endpoint id — its Ed25519 public key — is what is stored, `trusted_devices`,
  migration 0006). Each side saves the other; removing it (× on its row) takes effect at once.
- The trust list is handed to the transfer service on open and on every change.

### One-tap send (ALPN `selis/push/1`)

- The sender dials the trusted device by endpoint id (address lookup: n0 DNS/pkarr by default,
  mDNS in "local network only"; a custom relay without lookup reaches it on the LAN only).
- `Ping` → `Pong { receiving }` lets the Send tab show **Ready / Online · open Receive on it /
  Not reachable**. Untrusted devices get `Refused` and learn nothing.
- `Invite { ticket }`: an ordinary ticket of the sender (fresh one-time token, 10 minutes).
  The receiver accepts only if (1) the inviting device is trusted, (2) its **Receive tab is
  open** (`transfer_receiving`), (3) the ticket points back to the inviting device, (4) it is
  still valid. It then connects back exactly as after a scan (same gate, resume, BLAKE3).
- The sender skips the code only for the device it invited, only while it still trusts it;
  any other device presenting that ticket is refused. A device that does not trust the
  sender, or whose Receive tab is closed, makes the send fail with "not ready".

### Library move

- Manifest **version 2** (version 1 still read): per document its tags and favorite flag; for
  the library its signatures (PNG blobs, original ids) and settings (the stored key/value map).
  The device key is never part of it (OS secure storage, ADR 0011).
- Sent like any transfer (QR or trusted device) with every document and every library version.
  A dry-run summary (documents, earlier versions, tags, signatures, total size) is shown first.
- On arrival: documents are imported as received (dedupe by BLAKE3: an identical document is a
  duplicate), tags are added by name, favorites set, signatures added by id when missing,
  settings applied through the normal validation.
- **Blobs the receiver already has are not fetched** (`ServiceConfig::have` → the library file
  with that BLAKE3); the receive fetches blob by blob, so a repeated or resumed move moves only
  what is missing. Moving the same library twice changes nothing.

## Consequences

- Resuming a move after an interruption works as for any receive (session token).
- Trust is per pair and symmetric by user action; there is no discovery of untrusted devices.
- `docs/PRIVACY.md`: the trusted list holds names and public keys, on the device only.

## Update 2026-11-08 (the receiver decides; security audit run-1, lead 5)

- **A link never starts a receive by itself.** A `selis://transfer` link (from any app or web
  page), a scanned or a pasted code first shows who sends it (`transfer_ticket_sender`: the
  device id, or its name when it is a saved device); nothing connects until "Receive".
- **Settings from the sender are described, not applied.** The receive's `done` view carries
  `ForeignSettings`; the same confirmation as for packs (ADR 0012 update) applies them.
- **Signatures only from a saved (trusted) device.** Others are counted
  (`signaturesSkipped`) and not added; the done card says so. To move signatures, save the old
  device first, then move.
- **Dedupe only for a trusted push.** Skipping blobs the receiver already has tells the sender
  which BLAKE3 hashes this device holds, so a ticket receive fetches every blob (duplicates are
  still recognised on import); a saved device's push keeps the dedupe.
