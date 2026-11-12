# Selis — Phone UI brief (approved 2026-10-11)

Source: approved phone mockups (private design canvas, 6 artboards, 390×844).
This file is the implementation reference for P1+. Values below are exact.
Tokens come from `packages/ui/src/tokens.css` — never hardcode colors in components.

## Global

- Frame: 390×844 reference phone. Top safe area ≈ 48 px (use `--safe-top`), bottom tab bar 84 px incl. 28 px bottom inset (use `--safe-bottom`).
- No fake status bar. Font: Inter Variable (self-hosted).
- Large title screens (Library, Transfer, Settings): header 52 px, title 28 px / 700 / letter-spacing -0.02em, padding-left 20.
- Detail screens (Viewer, Annotate, Pages): top bar = safe-top + 52 px, bg `--surface-app`, 1 px bottom border `--neutral-5`.
- Icon buttons: 44×44, radius 22, icon 22 px stroke 1.75 (Lucide).
- Section labels (h2): 13 px / 600 / `--neutral-11`, margin 20 top 8 bottom.
- Cards/groups: bg `--surface-raised`, 1 px border `--neutral-5`, radius 14.
- Selection highlight pattern: bg `--accent-3` + text/icon `--accent-9` (light) / `--accent-11` (dark) + weight 600.
- Every label is an i18n key (en + el). **English copy is primary** (`en`, the default language on first launch whatever the device language); Greek is its translation (`el`). This brief was written with the Greek copy: where it quotes Greek, that is the `el` value of a key whose English text in `en.json` is the reference. Layouts must fit both (the visual snapshots cover English first, Greek as a second set).

## Bottom tab bar (Library, Recent, Transfer, Settings)

- 4 equal columns, padding 6 8 28, bg `--surface-app`, top border 1 px `--neutral-5`.
- Item: icon in a 56×30 pill (radius 15) + label 12 px. Active: pill bg `--accent-3`, color accent, weight 600, `aria-current="page"`. Inactive: `--neutral-11`, weight 500.
- Labels: Βιβλιοθήκη, Πρόσφατα, Μεταφορά, Ρυθμίσεις.

## 1. Library (Βιβλιοθήκη) — P1

- Header: title + icon buttons Search (Αναζήτηση) and Sort (Ταξινόμηση), right-aligned, padding-right 8.
- Filter chips row (padding 8 20 16, gap 8): Όλα, Αγαπημένα, Ελήφθησαν. Chip height 44, radius 22, 14 px. Active: bg `--neutral-12`, text `--neutral-1`, 600. Inactive: 1 px `--neutral-6` border, `--neutral-11`, 500. `aria-pressed`.
- Grid: 2 columns, gap 20 (row) × 16 (col), padding 0 20.
- Card (whole card is a link to the Viewer):
  - Thumb area height 212, radius 12, bg `--neutral-3`, centered page thumbnail ~128×176 with `--shadow-1`, radius 3.
  - Badges: favorite star top-right (warning color); "Ελήφθη" pill top-left (11 px / 600, bg `--accent-3`, text accent) for received docs.
  - Title 14 px / 600, line-height 1.35, max 2 lines. Meta 12 px `--neutral-11`: "12 σελ. · Σήμερα" (relative date).
  - Thumbnail skeleton while rendering — no layout shift.
- FAB: "Εισαγωγή PDF", right 20, bottom = tab bar + 20, height 56, radius 18, bg `--accent-9`, text `--accent-contrast`, 15 px / 600, plus icon, `--shadow-3`.
- Empty state (not in mockup, required): illustration + one action "Εισαγωγή PDF".
- Recent tab in P1 = same grid sorted by last_opened_at, no FAB.

## 2. Viewer — P1

- Canvas bg: `--page-canvas`. Pages full width minus 16 px side padding, gap 12, `--shadow-1`, radius 2.
- Top bar: back link (to Library) · title 16 px / 600 ellipsis + subtitle 12 px "Σελίδα 3 από 12 · αποθηκεύτηκε" · Search · More (⋮).
- Page indicator chip: top-right under the bar (top +12, right 24), "3 / 12", 12 px / 600 tabular, bg rgba(33,31,26,.74), white text, radius 12. Auto-hides 1.5 s after scroll stops.
- Scrubber: right edge, 4 px track, 44 px thumb; draggable for fast seek (hit area ≥ 44 px wide).
- Floating dock: left/right 16, bottom 28 + safe-bottom, height 64, radius 20, bg `--surface-raised`, `--shadow-3`, 1 px border. 5 equal items (icon 22 + label 11 px / 500):
  Σχολιασμός (→ Annotate, P2), Υπογραφή (P2), Σελίδες (→ Pages, P2), Αποστολή (→ Transfer, P3), Κοινοποίηση (OS share sheet).
  In P1, P2/P3 items render disabled with a "Σύντομα" tooltip/toast — keep the layout final.
- Dock hides on scroll down, shows on scroll up / tap (motion 200 ms).

## 3. Annotate (Σχολιασμός) — P2, reference only

- Top bar: close (X → Viewer) · "Σχολιασμός" · Undo · Redo (disabled state 45% opacity) · "Τέλος" pill (height 40, accent bg).
- Bottom sheet: radius 20 20 0 0, `--surface-raised`, `--shadow-3`, grab handle 36×4.
  - Tool row: horizontally scrollable, items 76×60, radius 12, icon 22 + label 11 px. Tools: Επισήμανση, Υπογράμμιση, Στυλό, Κείμενο, Σημείωση, Γόμα. Selected = selection highlight pattern. `aria-pressed`.
  - Color row: radiogroup, 5 swatches 28 px in 44 px hit targets; selected ring = 2 px surface + 2 px `--neutral-12`. Colors: Κίτρινο #f4c430, Πράσινο #5fbf7f, Ροζ #ef7fae, Μπλε #6ea8f0, Πορτοκαλί #f39a4a (highlight alpha ≈ .42). Selected color name shown right, 12 px.
  - Thickness: label "Πάχος" + range 1–12, accent-color accent.
- Sticky note popover: 150 px wide, bg #fff6d6, border #ecd48a, radius 8, title "Σημείωση" 600.

## 4. Pages (Σελίδες) — P2, reference only

- Top bar: close · "{n} επιλεγμένες" (plural via ICU) · "Επιλογή όλων" text button (accent, 600).
- Hint 13 px `--neutral-11`: "12 σελίδες · Πατήστε παρατεταμένα και σύρετε για αλλαγή σειράς".
- Grid: 3 columns, gap 16 × 14, thumbs height 148, radius 4. Selected: 2 px accent ring (box-shadow, no layout shift) + 22 px check badge top-right; page number below 12 px, accent + 600 when selected.
- Bottom action bar (5): Περιστροφή, Αντιγραφή, Εξαγωγή, Προσθήκη PDF, Διαγραφή (danger color, confirm dialog).

## 5. Transfer (Μεταφορά) — P3, reference only (P1: tab exists, screen shows "Σύντομα" empty state)

- Segmented control (tablist): Αποστολή / Λήψη. Height 44, padding 3, radius 12, bg `--neutral-3`; selected segment bg `--surface-raised` + `--shadow-1`, radius 9, 14 px / 600.
- Send card: "3 έγγραφα · 14,2 MB" 15 px / 600 + helper 13 px; QR 176 px on white with 10 px padding (QR always black on white, all themes); "Κωδικός επιβεβαίωσης" 12 px + code 30 px / 700 / letter-spacing .08em tabular ("482 913"); route chip 32 px (bg success-3, text success-11): "Ίδιο Wi‑Fi · απευθείας σύνδεση" / "Μέσω relay" variant.
- Receive: dark camera viewfinder 320 px with 4 white corner brackets; button "Επικόλληση συνδέσμου" (48 px, outlined); helper about matching the 6-digit code.
- Footer line with lock icon: "Κρυπτογραφημένο από άκρο σε άκρο. Χωρίς λογαριασμό, χωρίς αποθήκευση στο cloud."
- Trusted devices list: rows 60 px, 36 px icon tile, name 15 / 600, status 12, "Αποστολή" pill (disabled when offline).

## 6. Settings (Ρυθμίσεις) — P1

- Εμφάνιση card:
  - "Θέμα" + radiogroup **2×2 grid** (approved; replaces the 4-option segmented control that overflowed): Σύστημα, Φωτεινό, Σκούρο, Σέπια. Tile height 52, radius 12, mini swatch 30×22 (system = half light/half dark) with 8 px accent dot; selected = inset 2 px accent ring + `--accent-3` bg + 600.
  - Divider, then row "Γλώσσα" → value "English" by default + chevron (opens the picker: English, Ελληνικά, "Same as the device"; the choice is stored).
- Μεταφορά card: switch "Μόνο τοπικό δίκτυο" + helper "Χωρίς relay. Η μεταφορά δουλεύει μόνο στο ίδιο Wi‑Fi." (default off; persisted now, used in P3).
- Αποθήκευση card: rows "Εκδόσεις ανά έγγραφο" = 10, "Όριο ιστορικού" = 200 MB (tap opens picker).
- Ασφάλεια card: switch "Κλείδωμα εφαρμογής" + helper "Με δακτυλικό αποτύπωμα ή Face ID" (P1: setting persisted, biometric gate may land later — render disabled with "Σύντομα" if not implemented).
- Footer 12 px centered: "Selis {version} · Apache-2.0 · Χωρίς λογαριασμό, χωρίς tracking".
- Switch: 48×28 track (on = accent, off = `--neutral-6`), 22 px white knob, 200 ms; in a 52×44 button with `role="switch"` + `aria-checked` + `aria-labelledby`.
- Theme changes apply instantly to the whole app and persist.
