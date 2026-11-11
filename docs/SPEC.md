# Selis — Architecture Spec

Source of truth (live doc): https://claude.ai/code/artifact/ad84c752-ae7a-4a76-8814-1f00839654fc
Exported: 2026-10-09. Αν αλλάξει το live doc, ξανακάνε export εδώ.

## Current status (2026-11-01)

- **Release:** v1.0.0-rc.4, μόνο Android: δημοσιευμένο στα GitHub Releases (updates με Obtainium) και στο Play Internal testing. Το Play Closed testing τρέχει ακόμη το rc.1 και θέλει 12 opted-in testers. iOS και desktop δεν έχουν κυκλοφορήσει (iOS μόνο builds στο CI).
- **Phases:** P7a (Scan 2.0, ADR 0032), P7b (Erase, ADR 0033) και P7c (μετατροπή αρχείων από/προς PDF, ADR 0035) έγιναν. Το P7c είναι στο main, όχι σε release.
- **Επόμενο:** AI features, με απόφαση πρώτα στο ADR 0036.
- **English first** (ADR 0030 + amendment): η εφαρμογή ανοίγει στα αγγλικά· νέα strings μόνο στο `en.json`, τα ελληνικά συμπληρώνονται στο translation pass πριν από κάθε release candidate.
- **Signing μόνο στο CI** (ADR 0021 + amendment 1): release builds unsigned by design, υπογραφή μόνο στο `release-android.yml` από GitHub secrets· κανένα signing password σε αρχεία ή environment variables.

## Στόχος και αρχές

Ένα δωρεάν, open-source PDF editor για Windows, macOS, Linux, Android και iOS από **ένα codebase**, χωρίς λογαριασμό, χωρίς server, με ποιοτικό UI. Δημόσιο repo στο GitHub με links για App Store, Google Play, F-Droid και GitHub Releases.

**Αρχές προϊόντος (μη διαπραγματεύσιμες):**

- No account, no login, no cloud storage. Ό,τι κάνει ο χρήστης μένει στη συσκευή.
- Μηδέν network by default. Δίκτυο ανοίγει μόνο όταν ο χρήστης ξεκινά μεταφορά.
- No ads, no tracking, no telemetry, no analytics SDKs.
- Non-destructive: το αρχικό PDF δεν χάνεται ποτέ σιωπηλά. Κάθε save = νέα έκδοση.
- Mobile-first: Android → iOS → desktop. Ίδιο codebase, layout προσαρμοσμένο σε phone, tablet, desktop.
- Αγγλικά + Ελληνικά από την πρώτη μέρα. **English first:** η εφαρμογή ανοίγει στα αγγλικά την πρώτη φορά, ό,τι κι αν είναι η γλώσσα της συσκευής· τα ελληνικά επιλέγονται στις Ρυθμίσεις → Γλώσσα και μένουν (αποθηκεύονται). Το αγγλικό κείμενο (copy) είναι το πρωτότυπο, το ελληνικό η μετάφρασή του (2026-10-12).

**Ταυτότητα (προσωρινή — επιβεβαίωσε):**

| Πεδίο | Τιμή |
| --- | --- |
| Working name | Selis (από «σελίς») — έλεγχος trademark, domain, store names πριν το publish |
| Repo | github.com/anywecon/selis (public) |
| Bundle / package ID | com.anywecon.selis |
| Άδεια κώδικα | Apache-2.0 (ίδια με EmbedPDF, store-compatible) |
| Publisher | Any WeCon |
| Χρηματοδότηση | GitHub Sponsors / Liberapay στο README και site — όχι μέσα στο iOS app |

## Stack και PDF engine

**Απόφαση:** Tauri 2 για όλες τις πλατφόρμες, React UI σε webview, PDF engine = EmbedPDF (PDFium σε WebAssembly) μέσα σε Web Worker, Rust core για αρχεία, βιβλιοθήκη και μεταφορά. Ένα UI, ένας engine, πέντε πλατφόρμες.

| Layer | Επιλογή | Ρόλος |
| --- | --- | --- |
| Shell | Tauri 2 (γραμμή 2.12.x, pinned — η 2.11 / wry 0.55 χάνει IPC replies στο Android resume) | Windows, macOS, Linux, Android, iOS από ένα project |
| UI | React + TypeScript strict + Vite | Όλη η διεπαφή |
| Styling | Tailwind v4 + Radix primitives (shadcn/ui pattern) + Motion | Design system, animations |
| State | Zustand (UI state) + TanStack Query (IPC cache) | Χωρίς Redux |
| PDF engine | [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) **v2 branch**, headless | Render, search, text select, annotations, forms, redaction, page import/export |
| Rust core | Δικά μας crates | File I/O, SQLite index, versions, thumbnails cache, iroh transfer |
| IPC types | tauri-specta | TS bindings παράγονται από Rust — μηδέν χειρόγραφα types |
| DB | SQLite μέσω rusqlite (bundled) | Library index, settings, devices |
| Heavy ops (P4) | qpdf (Apache-2.0) | Encrypt, compress, linearize, repair |
| OCR (P4) | Tesseract (el + en traineddata) | Searchable PDFs από scans |

**Γιατί όχι οι εναλλακτικές:**

- **MuPDF**: AGPL. Θα έκανε όλο το app AGPL και έχει γνωστή σύγκρουση με τους όρους του App Store.
- **pdf-lib**: ουσιαστικά unmaintained και χάνει AcroForm fields στο merge — το είδαμε ήδη στο AnyPDF.
- **pdf.js**: μόνο rendering, δεν γράφει PDF.
- **React Native / Expo + Tauri**: δύο UIs για συντήρηση. Το PDF canvas είναι web-native ούτως ή άλλως.
- **Flutter**: δεν μοιράζεται τον web PDF engine, ξένο stack για το studio.

**EmbedPDF**: Apache-2.0, ο engine είναι fork του PDFium (Apache-2.0). Το v3 δηλώνεται ακόμη μη production-ready, άρα κλειδώνουμε σε v2 και κάνουμε migration αργότερα.

**Σχέση με AnyPDF:** νέο repo από μηδέν. Το AnyPDF μένει internal. Κρατάμε από εκεί τα UX lessons, τα test fixtures και τη λογική safe-save — όχι το pdf-lib layer.

## Repo structure

Monorepo με npm workspaces + Cargo workspace. Ένα Tauri app για όλες τις πλατφόρμες. Η λογική ζει σε crates/packages χωρίς εξάρτηση από Tauri, ώστε να τεστάρεται μόνη της.

Αρχιτεκτονική σε layers:
- WebView (React + TS strict): React UI (shells desktop/tablet/phone, Zustand, TanStack Query, i18n) → packages/engine (EmbedPDF v2, PDFium WASM σε Web Worker).
- typed IPC (tauri-specta) ↓
- Rust core (Tauri 2 commands): selis-core (SQLite, versions, atomic save, BLAKE3) · selis-transfer (iroh 1.0 + iroh-blobs) · selis-pdfops (qpdf, Tesseract, P4).
- selis-core → αποθήκευση συσκευής (app data, Android SAF URIs, iOS bookmarks). selis-transfer → δίκτυο μόνο κατά τη μεταφορά (mDNS, direct QUIC, n0 relay).
- Το δίκτυο ανοίγει αποκλειστικά από το selis-transfer.

```
selis/
├─ apps/app/                      # The single Tauri app
│  ├─ src/                        # React UI
│  │  ├─ routes/                  # library, viewer, transfer, settings, onboarding
│  │  ├─ features/                # library, viewer, annotate, sign, forms,
│  │  │                           # pages, redact, transfer, settings
│  │  ├─ layouts/                 # DesktopShell, TabletShell, PhoneShell
│  │  ├─ lib/                     # ipc.ts (generated bindings), platform.ts
│  │  └─ i18n/el.json, en.json
│  ├─ src-tauri/
│  │  ├─ src/lib.rs               # builder, plugins, state
│  │  ├─ src/commands/            # thin wrappers → crates (no logic here)
│  │  ├─ capabilities/            # desktop.json, mobile.json (least privilege)
│  │  ├─ gen/android/, gen/apple/ # generated, committed
│  │  ├─ tauri.conf.json
│  │  ├─ tauri.android.conf.json, tauri.ios.conf.json
│  │  └─ icons/
│  └─ e2e/                        # Playwright (web), Maestro flows (mobile)
├─ crates/
│  ├─ selis-core/                 # library index, versions, atomic file store
│  ├─ selis-transfer/             # iroh endpoint, tickets, pairing, pack format
│  └─ selis-pdfops/               # qpdf ops (P4)
├─ packages/
│  ├─ engine/                     # EmbedPDF wrapper, Web Worker, typed API
│  ├─ ui/                         # design tokens + primitives
│  └─ fixtures/                   # PDF test corpus (forms, encrypted, Greek, 1000 pages)
├─ docs/                          # SPEC.md, ARCHITECTURE.md, adr/, PRIVACY.md, badges/, screenshots/
├─ fastlane/metadata/android/     # Play + F-Droid listings (el, en)
├─ .github/workflows/             # ci, release-desktop, release-android, release-ios
├─ CLAUDE.md                      # Claude Code rules for this repo
├─ README.md, LICENSE, NOTICE, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
└─ deny.toml, rust-toolchain.toml, .nvmrc
```

**Κανόνες ορίων:**

- Το UI δεν αγγίζει filesystem ή network απευθείας. Μόνο μέσω `lib/ipc/` (generated bindings + reliability layer, ADR 0005).
- Τα `commands/` είναι thin: validate input → καλούν crate → επιστρέφουν typed result.
- Το `packages/engine` είναι ο μόνος που μιλά με EmbedPDF. Αν αλλάξει engine, αλλάζει μόνο αυτό.
- Κάθε αρχιτεκτονική απόφαση γράφεται ως ADR στο `docs/adr/` (π.χ. 0001-tauri-for-all-platforms).

## Data model και local storage

Όλα σε app data directory της συσκευής. Το αρχικό αρχείο δεν γράφεται ποτέ από πάνω χωρίς ρητή επιλογή «Save to original».

**Δύο τρόποι ύπαρξης εγγράφου:**

- **Imported**: αντίγραφο μέσα στη βιβλιοθήκη του app (default σε mobile).
- **Linked**: δείκτης σε εξωτερικό αρχείο — path σε desktop, SAF persisted URI σε Android, security-scoped bookmark σε iOS. Αν χαθεί η πρόσβαση, το UI προτείνει import.

**SQLite schema (selis-core):**

| Πίνακας | Βασικά πεδία |
| --- | --- |
| documents | id (uuid v7), title, kind (imported/linked), location, blake3, size_bytes, page_count, created_at, modified_at, last_opened_at, favorite, thumbnail_path |
| versions | id, document_id, seq, blake3, size_bytes, created_at, label (auto/manual/received/erase), file_path, note (what an erase or redaction did to annotations over the area; ADR 0033) |
| tags, document_tags | Οργάνωση βιβλιοθήκης |
| signatures | id, kind (drawn/typed/image), svg_or_png_path, created_at |
| devices | endpoint_id, display_name, paired_at, last_seen_at, trusted |
| transfers | id, direction, peer_endpoint_id, doc_count, bytes, status, started_at, finished_at |
| settings | key, value (JSON) |

**Κανόνες αποθήκευσης:**

- Atomic save: write σε temp → fsync → rename. Ποτέ μισό αρχείο.
- Κάθε save δημιουργεί version. Κρατάμε τις τελευταίες 10 ή έως 200 MB ανά έγγραφο (ρυθμιζόμενο). Το v1 (πρωτότυπο) δεν διαγράφεται αυτόματα.
- Autosave σε working copy μετά από 3 s αδράνειας. Crash recovery στο επόμενο άνοιγμα.
- Undo/redo: in-memory command stack ανά session (history plugin του EmbedPDF), επιβιώνει μέχρι το κλείσιμο του εγγράφου.
- Content addressing με BLAKE3: ίδιο hash = ίδιο αρχείο, χωρίς διπλότυπα και με έτοιμο hash για τη μεταφορά.
- Thumbnails cache: WebP ανά σελίδα 1, εκκαθάριση με LRU πάνω από 300 MB.
- Migrations: versioned SQL αρχεία, τρέχουν στην εκκίνηση, με backup του DB πριν από κάθε migration.

## Μεταφορά αρχείων χωρίς λογαριασμό

**Απόφαση:** peer-to-peer με [iroh 1.0](https://iroh.computer/blog/v1) + iroh-blobs. Η «ταυτότητα» κάθε συσκευής είναι ένα Ed25519 κλειδί που φτιάχνεται τοπικά — δεν υπάρχει λογαριασμός. Οι συσκευές βρίσκονται με QR code και τα αρχεία πάνε απευθείας από τη μία στην άλλη, end-to-end encrypted (QUIC με TLS 1.3).

Το QR μεταφέρει μόνο το πώς βρίσκεται η συσκευή Α. Το iroh δοκιμάζει τους δρόμους 1 → 3 αυτόματα.

**Τρεις δρόμοι, αυτόματα με σειρά προτίμησης:**

1. **Ίδιο Wi-Fi**: εντοπισμός με mDNS, απευθείας σύνδεση, μέγιστη ταχύτητα, χωρίς internet.
2. **Διαφορετικά δίκτυα**: QUIC hole punching για απευθείας σύνδεση.
3. **Fallback**: public relay της n0. Ο relay βλέπει μόνο κρυπτογραφημένα πακέτα και IP metadata, ποτέ περιεχόμενο.

**Ροή χρήστη:**

1. Συσκευή Α: επιλέγει έγγραφα → «Αποστολή» → εμφανίζεται QR + 6-ψήφιος κωδικός επιβεβαίωσης.
2. Συσκευή Β: «Λήψη» → σκανάρει QR (ή επικολλά link).
3. Και οι δύο δείχνουν τον ίδιο κωδικό επιβεβαίωσης. Ο αποστολέας πατά «Επιβεβαίωση».
4. Μεταφορά με progress, resume αν κοπεί, BLAKE3 verification ανά chunk.
5. Τα έγγραφα μπαίνουν στη βιβλιοθήκη του Β με label «received», μαζί με το ιστορικό εκδόσεων αν επιλεγεί.

**Trusted devices:** μετά την πρώτη μεταφορά, ο χρήστης μπορεί να σώσει τη συσκευή. Μετά στέλνει με ένα tap («Στείλε στο laptop») χωρίς QR, όταν είναι και οι δύο online. Αφαίρεση trust ανά πάσα στιγμή.

**Μετακόμιση ολόκληρης βιβλιοθήκης:** ίδιος μηχανισμός με όλα τα έγγραφα, versions, tags και signatures — για αλλαγή κινητού.

**Offline fallback (χωρίς δίκτυο καθόλου):** export σε `.selispack` (zip + manifest.json), προαιρετικά κρυπτογραφημένο με passphrase (Argon2id + XChaCha20-Poly1305). Μεταφέρεται με USB, email, οποιοδήποτε cloud διαλέξει ο χρήστης, μέσω του OS share sheet. Import με «Open with».

**Ρυθμίσεις για παρανοϊκούς χρήστες:**

- «Μόνο τοπικό δίκτυο» (off by default): απενεργοποιεί relay και DNS lookup.
- Custom relay URL: self-hosted `iroh-relay`.

**Τεχνικές παράμετροι:**

| Παράμετρος | Τιμή |
| --- | --- |
| Crates | iroh 1.x, iroh-blobs (έκδοση συμβατή με iroh 1.x — επιβεβαίωση στο scaffold) |
| ALPN | `selis/transfer/1` |
| Ticket | EndpointAddr + collection hash + one-time token, λήγει σε 10 λεπτά |
| Ιδιωτικό κλειδί συσκευής | OS secure storage (Keychain, Android Keystore, Windows Credential Manager) |
| Ορατότητα | Endpoint ανοίγει μόνο στην οθόνη Μεταφοράς και κλείνει όταν βγει ο χρήστης |
| Μέγεθος | Χωρίς όριο, streaming από δίσκο, ποτέ ολόκληρο αρχείο στη RAM |
| Background (mobile) | iOS: foreground μόνο στο v1. Android 14+: user-initiated data transfer job κατά τη μεταφορά, Android 8–13: foreground service (ADR 0027) |

## Roadmap ανά phase

Mobile-first. Κάθε phase κλείνει μόνο όταν περάσει το verification gate (ενότητα Testing) σε Android, emulator και πραγματική συσκευή. Το iOS ελέγχεται μέσω CI και TestFlight. Τα desktop targets απλώς χτίζονται στο CI μέχρι το P6.

**Πολιτική συσκευών (2026-10-12):** προς το παρόν δεν υπάρχει πραγματική mid-range συσκευή. Τα phases P0–P4 κλείνουν στο **Galaxy S23** (πραγματική συσκευή) + στο AVD **`selis-midrange-api36`** (3 GB, 1080×2340, το mid-range proxy). Η μέτρηση σε **πραγματική mid-range Android** (π.χ. Snapdragon 6/7-series, 4–6 GB, με `scripts/measure-device.sh`) είναι **υποχρεωτικό gate του P5**: χωρίς αυτήν δεν γίνεται release 1.0.

1. **P0 — Foundation + spike**
   - Tauri 2 scaffold με Windows, macOS, Linux, Android, iOS targets. CI χτίζει όλα τα targets.
   - packages/engine: EmbedPDF v2 σε Web Worker, φορτώνει και κάνει render ένα PDF.
   - Design tokens, πλήρες PhoneShell, βασικό TabletShell, DesktopShell μόνο placeholder, i18n el/en, light/dark.
   - **Spike (gate):** PDF 1000 σελίδων σε mid-range Android και iPhone simulator — πρώτη σελίδα < 1 s, scroll χωρίς crash, μνήμη WebView < 600 MB. Αν αποτύχει, ενεργοποιείται το fallback της ενότητας Ρίσκα. (Μέχρι το P5: Galaxy S23 + AVD `selis-midrange-api36` ως proxy· η πραγματική mid-range μέτρηση είναι gate του P5.)
2. **P1 — Reader + Library**
   - Library: grid/list, sort, search τίτλων, favorites, tags, recents.
   - Import: file picker (Android SAF, iOS document picker), «Open with» / share intent (Android, iOS).
   - Viewer: virtualized scroll, pinch zoom, double-tap zoom, thumbnails, outline/bookmarks, full-text search, text selection και copy, rotate view, night mode για σελίδες.
   - AC: άνοιγμα από «Open with» σε Android και iOS, ομαλό scroll σε mid-range Android (μέχρι το P5: στο AVD `selis-midrange-api36`· σε πραγματική mid-range συσκευή στο P5), versions table γεμίζει σωστά.
3. **P2 — Editing core**
   - Annotations: highlight, underline, strike, ink/pen (stylus + Apple Pencil, palm rejection), shapes, free text, sticky notes, eraser.
   - Υπογραφές: draw, type (3 γραμματοσειρές), image. Αποθηκεύονται τοπικά, επαναχρησιμοποιούνται.
   - Forms: συμπλήρωση AcroForm, flatten, save.
   - Σελίδες: reorder με drag, rotate, delete, insert blank, duplicate, extract, merge πολλών PDF, split.
   - Redaction (πραγματική αφαίρεση περιεχομένου) + text overlay (whiteout + νέο κείμενο).
   - AC: merge PDF με AcroForm διατηρεί fields, κάθε save δημιουργεί version, undo/redo σε κάθε εργαλείο.
4. **P3 — Transfer**
   - iroh send/receive, QR, κωδικός επιβεβαίωσης, trusted devices, μετακόμιση βιβλιοθήκης, `.selispack` import/export.
   - AC: μεταφορά 200 MB σε ίδιο Wi-Fi και μέσω relay, resume μετά από διακοπή, ίδιο BLAKE3 στα δύο άκρα.
   - **Κατάσταση: done (2026-10-14).** AC στο S23 + AVD (`docs/spike-p3.md`)· χειροκίνητη σάρωση QR με την κάμερα του S23: direct (LAN), 50 MB σε 1,41 s ≈ 35,5 MB/s, ίδιο BLAKE3 (`docs/spike-p0.md`, «P3 close-out»). Η μεταφορά εκτός LAN σε πραγματική συσκευή μεταφέρθηκε στο gate του P5.
5. **P4 — Power tools**
   - Scan με κάμερα (edge detection, perspective, φίλτρα) → PDF.
   - OCR (Tesseract el + en) → searchable PDF.
   - qpdf: password protect/remove, compress, linearize, repair.
   - Images → PDF, export σελίδας ως PNG/JPEG.
   - **Κατάσταση: done (2026-10-14).** P4a qpdf (ADR 0015), P4b images (ADR 0017), P4c scan
     (ADR 0016), P4d OCR (ADR 0018)· μετρήσεις στο `docs/spike-p4.md`, Maestro σε S23 + AVD.
6. **P5 — Release 1.0**
   - **Gate (υποχρεωτικό, πριν από κάθε store release):** μέτρηση σε πραγματική mid-range Android με `scripts/measure-device.sh` (1000 σελίδες: πρώτη σελίδα < 1 s, πλήρες scroll χωρίς crash, μνήμη WebView < 600 MB) και επανάληψη του Maestro suite σε αυτήν. Αποτελέσματα στο `docs/spike-p0.md`.
   - **Gate (υποχρεωτικό, πριν από κάθε store release):** μεταφορά εκτός LAN σε πραγματική συσκευή (δεδομένα κινητής, hotspot άλλου κινητού ή απομονωμένο guest Wi-Fi), 200 MB: αναφορά διαδρομής direct ή relay, MB/s, BLAKE3 και στα δύο άκρα. Η διαδρομή relay καθαυτή καλύπτεται ήδη από το forced-relay AC του P3a (`docs/spike-p3.md`). Αποτελέσματα στο `docs/spike-p0.md`.
   - Mobile 1.0: Google Play, F-Droid, App Store, signed APK στο GitHub. Store listings en (πρωτότυπο) + el (μετάφραση), screenshots πρώτα στα αγγλικά, privacy pages, website με badges.

**P6 — Desktop 1.0:** πλήρες DesktopShell (sidebar, inspector, command palette, keyboard shortcuts, tabs), drag & drop, file associations, signed installers (Windows, macOS, Linux), winget, Microsoft Store, Flathub, opt-in updater.

**Εκτός v1 (ρητά):** επεξεργασία υπάρχοντος κειμένου μέσα στο PDF, ψηφιακές υπογραφές με πιστοποιητικό (PAdES), PDF/A conversion, συνεργασία πολλών χρηστών.

## UI/UX design system

**Κατεύθυνση: «calm paper».** Το έγγραφο είναι ο ήρωας, το chrome υποχωρεί. Ποιότητα = συνέπεια, ρυθμός, μικρο-λεπτομέρειες στην κίνηση, όχι στολίδια.

**Tokens (packages/ui):**

| Token | Τιμή |
| --- | --- |
| Χρώματα | Ζεστά neutrals (12 βαθμίδες), ένα accent (deep ink blue), semantic success/warning/danger. Όλα ως CSS variables, light + dark + «sepia» για ανάγνωση |
| Γραμματοσειρά UI | Inter variable (καλύπτει ελληνικά), self-hosted — όχι Google Fonts CDN |
| Κλίμακα κειμένου | 12 / 14 / 16 / 20 / 24 / 32, line-height 1.4–1.5 |
| Spacing | 4 px grid |
| Radius | 8 (controls), 12 (cards), 20 (sheets) |
| Elevation | 3 επίπεδα, απαλές σκιές μόνο σε floating στοιχεία |
| Motion | 150–250 ms, spring για sheets και drag, σεβασμός `prefers-reduced-motion` |
| Icons | Lucide, 20 px, stroke 1.75 |
| Touch targets | ≥ 44 × 44 pt |

**Layouts ανά συσκευή:**

- **Desktop**: αριστερό sidebar βιβλιοθήκης (collapsible), compact toolbar επάνω, δεξί inspector panel για ιδιότητες εργαλείου, command palette (Ctrl/Cmd+K), πλήρη keyboard shortcuts, tabs για πολλά έγγραφα.
- **Tablet**: split view (thumbnails + σελίδα), εργαλεία σε floating dock, Apple Pencil / stylus-first annotation.
- **Phone**: bottom tab bar (Βιβλιοθήκη, Πρόσφατα, Μεταφορά, Ρυθμίσεις). Viewer full-bleed, tool dock στο κάτω μέρος στη ζώνη του αντίχειρα, bottom sheets για επιλογές, swipe για thumbnails.

**Σημάδια ποιότητας (acceptance για κάθε οθόνη):**

- Μηδέν layout shift: skeletons για thumbnails, σταθερά μεγέθη.
- Optimistic UI σε όλες τις τοπικές ενέργειες.
- Haptics σε mobile για επιβεβαιώσεις (Tauri haptics plugin).
- Safe areas, edge-to-edge σε Android, dynamic island / notch σε iOS.
- Empty states με εικονογράφηση και μία καθαρή ενέργεια.
- Onboarding 3 οθονών, παραλείψιμο, εξηγεί «χωρίς λογαριασμό, όλα στη συσκευή σου».
- Accessibility: WCAG 2.2 AA contrast, focus rings, screen reader labels, πλήρης χρήση με πληκτρολόγιο.

**i18n:** en + el από P0 (en = πρωτότυπο copy και default γλώσσα, el = μετάφραση· visual snapshots: αγγλικό κύριο σετ + ελληνικό δεύτερο σετ), ICU message format (Lingui ή i18next με ICU), καθόλου hardcoded strings. Για τις typed υπογραφές χρειάζονται script γραμματοσειρές με ελληνικά (OFL) — έλεγχος στο P2.

**Διαδικασία:** σχεδιάζουμε τις 6 βασικές οθόνες (Library, Viewer, Annotate, Pages, Transfer, Settings) ως design mockups σε phone + desktop πριν το P1. Το Claude Code υλοποιεί από αυτά, όχι από φαντασία.

## Security, privacy, permissions

Το app δεν συλλέγει τίποτα. Store disclosures: Play Data safety «No data collected», App Store «Data Not Collected».

**Runtime:**

- Strict CSP στο Tauri: καμία εξωτερική πηγή script/style/font, `connect-src` μόνο `ipc:` και `asset:`.
- Tauri capabilities ανά πλατφόρμα με least privilege. Καμία shell/exec capability.
- PDF parsing μέσα σε WASM sandbox σε Web Worker. Καμία εκτέλεση JavaScript από PDF (επιβεβαίωση ότι το EmbedPDF build δεν περιέχει V8/XFA).
- Fuzz tests στα Rust parsers (manifest του `.selispack`, tickets) με cargo-fuzz.
- Προαιρετικό app lock με biometrics (Tauri biometric plugin σε mobile).
- Μηδέν network στο startup. Δεν υπάρχει update check σε store builds.

**Permissions:**

| Πλατφόρμα | Permission | Γιατί |
| --- | --- | --- |
| Android | INTERNET, ACCESS_NETWORK_STATE | Μόνο για μεταφορά |
| Android | CHANGE_WIFI_MULTICAST_STATE | mDNS σε ίδιο Wi-Fi |
| Android | CAMERA (runtime) | QR και scan |
| Android | RUN_USER_INITIATED_JOBS (14+), FOREGROUND_SERVICE (μόνο ≤ 13) | Μεταφορά που δεν κόβεται (ADR 0027) |
| Android | Καμία storage permission | Χρήση SAF / photo picker |
| iOS | NSLocalNetworkUsageDescription + NSBonjourServices | mDNS |
| iOS | NSCameraUsageDescription | QR και scan |
| iOS | PrivacyInfo.xcprivacy | Υποχρεωτικό privacy manifest |

**Supply chain:**

- cargo-deny (licenses + advisories), npm audit, Dependabot, lockfiles committed.
- Μόνο permissive άδειες σε dependencies (Apache-2.0, MIT, BSD, ISC, OFL για fonts). GPL/AGPL μπλοκάρεται από το cargo-deny.
- Releases: SHA-256 checksums + SBOM (CycloneDX) + signed artifacts.
- SECURITY.md με private vulnerability reporting του GitHub.

**Κλειδιά που ΔΕΝ μπαίνουν στο repo:** Android upload keystore, Apple certificates, Windows signing, Tauri updater private key. Όλα ως GitHub Actions secrets.

## Testing και verification gate

Το UI τρέχει και σε απλό browser με mock IPC layer, ώστε Playwright και visual tests να μη χρειάζονται native build.

| Επίπεδο | Εργαλείο | Τι καλύπτει |
| --- | --- | --- |
| TS unit | Vitest | stores, engine wrapper, i18n keys, utils |
| Rust unit | cargo test, clippy -D warnings, fmt --check | selis-core, selis-transfer, versions, atomic save |
| Integration | cargo test με δύο iroh endpoints in-process | Μεταφορά, resume, hash verification |
| E2E web | Playwright (Chromium + WebKit) | Ροές βιβλιοθήκης, viewer, annotate, pages |
| Visual | Playwright screenshots | Κάθε οθόνη σε light/dark, phone/desktop |
| E2E Android | Maestro σε emulator | Import, annotate, save, transfer UI |
| E2E iOS | Maestro σε simulator (macOS runner) | Ίδιες ροές |
| Desktop smoke | tauri-driver (WebDriver) σε Windows | Άνοιγμα, save, file association |
| Fuzz | cargo-fuzz | Ticket και pack parsers |

**PDF corpus (packages/fixtures):** AcroForm, encrypted, scanned, ελληνικό κείμενο, 1000 σελίδες, κατεστραμμένο, με annotations από Acrobat, landscape/mixed sizes. Κάθε feature τεστάρεται απέναντι σε όλο το corpus.

**Gate:**

- **Tier 1 (κάθε αλλαγή):** `tsc --noEmit`, eslint, Vitest affected, `cargo clippy`, `cargo test` affected.
- **Tier 2 (τέλος feature):** όλα τα tests, `tauri build` Windows, `tauri android build` debug, Playwright + Maestro Android.
- **Tier 3 (release):** CI matrix σε όλες τις πλατφόρμες + Maestro iOS + manual checklist σε πραγματικές συσκευές.
- Performance budgets στο CI: πρώτη σελίδα < 1 s (fixture 1000 σελίδων), JS bundle < 1.5 MB gz χωρίς το WASM.

## CI/CD, signing, distribution

Public repo = δωρεάν GitHub Actions minutes, μαζί με macOS runners. Έτσι χτίζεται iOS και macOS χωρίς δικό σου Mac. Για τεστ σε πραγματικό iPhone χρειάζεται TestFlight.

**Workflows (.github/workflows):**

| Αρχείο | Trigger | Κάνει |
| --- | --- | --- |
| ci.yml | PR, push main | Tier 1 + Tier 2 σε ubuntu, windows. Android debug build |
| release-desktop.yml | tag `v*` | tauri-action: Windows NSIS + MSI (signed), macOS universal DMG (notarized), Linux AppImage + deb + rpm. Draft GitHub Release + checksums + SBOM |
| release-android.yml | tag `v*` | Signed AAB → Play internal track (fastlane supply). Universal signed APK → GitHub Release (Obtainium) |
| release-ios.yml | tag `v*` | macOS runner → IPA → TestFlight (fastlane pilot) |
| fdroid | εξωτερικά | Το F-Droid χτίζει από source με δικό του recipe στο fdroiddata. Απαιτεί reproducible build |

**Κανάλια διανομής:**

| Κανάλι | Κόστος | Signing / σημειώσεις |
| --- | --- | --- |
| GitHub Releases | 0 | Όλες οι πλατφόρμες. Checksums + SBOM |
| Google Play | 25 USD εφάπαξ | Play App Signing, AAB, target API του τρέχοντος έτους |
| F-Droid | 0 | Build from source, χωρίς Google libraries |
| Obtainium | 0 | Διαβάζει τα GitHub Releases |
| Apple App Store + Mac | 99 USD/έτος | Ένας λογαριασμός για iOS + Developer ID notarization στο macOS |
| Windows | 0 με [SignPath Foundation](https://signpath.org/) | Δωρεάν signing για OSS. Θέλει πλήρως αυτοματοποιημένο CI build και MFA |
| winget | 0 | Manifest PR στο winget-pkgs μετά από κάθε release |
| Microsoft Store | Έλεγχος τρέχοντος fee | MSIX από το ίδιο build |
| Flathub | 0 | Linux, προαιρετικά μετά το 1.0 |

**Desktop updates:** Tauri updater (signed manifests) μόνο στα GitHub builds, ρητά opt-in στις ρυθμίσεις, απενεργοποιημένο σε store builds. Συμβατό με την αρχή «μηδέν network by default».

**README:** logo, μία πρόταση, σειρά από badges (App Store, Google Play, F-Droid, Obtainium, GitHub Releases, winget, Microsoft Store), 4 screenshots, λίστα «No ads · No tracking · No account · No cloud storage», Exodus Privacy badge για Android, Features, Build from source, Contributing, Translations, License. Τα badges ζουν στο `docs/badges/` με τα επίσημα artwork κάθε store.

**Versioning (ADR 0020):** SemVer (`X.Y.Z`, `X.Y.Z-rc.N`) με μία πηγή, το `version` του root `package.json` (`tools/release/version.ts`), Conventional Commits, `CHANGELOG.md` (Keep a Changelog, χειροκίνητο). build = ((major·100 + minor)·100 + patch)·100 + (N ή 99)· Android versionCode = build·10 + ψηφίο ABI· iOS CFBundleVersion = build.

## Ρίσκα και ανοιχτές αποφάσεις

| Ρίσκο | Επίπτωση | Αντιμετώπιση |
| --- | --- | --- |
| Tauri mobile ωριμότητα, WebView σε low-end Android | Αργό UI ή crashes | Spike στο P0 με gate. Fallback: native PDFium μέσω Rust (pdfium-render) για rendering σε bitmap στο mobile, ίδιο UI |
| Χαμένα IPC replies στο Android resume (Tauri 2.11 / wry 0.55) | UI κολλάει σε import/save | Λύθηκε: Tauri 2.12 (0/20 σε repro) + reliability layer με request id και take_result (ADR 0005) |
| iOS WKWebView όριο μνήμης για WASM | Crash σε τεράστια PDF | Render ανά σελίδα με tiling, όριο cache, ίδιο fallback |
| EmbedPDF v3 ακόμη μη production | Breaking changes | Pin σε v2, όλη η επαφή μέσα στο packages/engine |
| F-Droid και prebuilt WASM | Απόρριψη από F-Droid | Build του PDFium WASM από source στο CI, reproducible |
| Μεταφορά μέσω public relay της n0 | Εξάρτηση από τρίτο server, IP metadata | Toggle «μόνο τοπικό δίκτυο», custom relay URL |
| Donation links στο iOS app | Απόρριψη στο review | Donations μόνο σε README και website |
| «Υπογραφή» ≠ ψηφιακή υπογραφή | Νομική σύγχυση για χρήστες | Σαφές label «οπτική υπογραφή». PAdES εκτός v1 |
| Όνομα Selis | Σύγκρουση trademark ή store | Τυπικός έλεγχος πριν το P5. Το GitHub repo μετονομάζεται εύκολα, με αυτόματο redirect |

**Αποφάσεις (9 Οκτωβρίου 2026):**

- **Όνομα:** Selis, bundle ID com.anywecon.selis. Σε πρόχειρη αναζήτηση δεν βρέθηκε PDF app με ίδιο όνομα. Τυπικός έλεγχος σε EUIPO/USPTO και στα stores πριν το P5.
- **Άδεια:** Apache-2.0. Ίδια με EmbedPDF, με ρητό patent grant και απλή για contributors. Το MPL προστατεύει μόνο ανά αρχείο, άρα δεν αξίζει την πολυπλοκότητα.
- **Relay:** ενεργό by default, αλλά μόνο όσο είναι ανοιχτή η οθόνη Μεταφοράς. Η μεταφορά πρέπει να δουλεύει παντού χωρίς ρυθμίσεις, και το περιεχόμενο μένει πάντα E2E κρυπτογραφημένο. Στις ρυθμίσεις υπάρχει toggle «Μόνο τοπικό δίκτυο». Η οθόνη δείχνει ποιος δρόμος χρησιμοποιείται: LAN, direct ή relay.
- **Microsoft Store:** μαζί με το Desktop 1.0 (P6), όχι νωρίτερα.
- **SignPath:** αίτηση στην αρχή του P6, όταν θα υπάρχουν desktop builds από το CI και δημόσια mobile releases ως ιστορικό του project.

## Πηγές

- [EmbedPDF — GitHub repo (άδεια, v2/v3 status)](https://github.com/embedpdf/embed-pdf-viewer)
- [EmbedPDF — PDFium JavaScript API docs](https://www.embedpdf.com/docs/pdfium/introduction)
- [iroh 1.0 — release announcement](https://iroh.computer/blog/v1)
- [iroh — crate docs](https://docs.rs/crate/iroh/latest)
- [SignPath Foundation — δωρεάν code signing για OSS](https://signpath.org/)
- [SignPath Foundation — όροι](https://signpath.org/terms)
