#!/usr/bin/env bash
# Hooks for pack.yaml (run.sh PRE_RUN / POST_RUN).
#
#   PRE_RUN="apps/app/e2e/maestro/pack.sh pre" POST_RUN="apps/app/e2e/maestro/pack.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/pack.yaml
#
# pre:   make plain / protected / tampered packs of three fixtures with the Sepia theme
#        on the host (crates/selis-core/examples/selispack.rs), push them to
#        Download/selis-fixtures, clear Selis and open Files in that folder.
# check: app data holds exactly the three fixtures (BLAKE3 as on the host), no staging
#        or import copies are left, the packs in Download/ are byte-identical, and the plain
#        pack the flow saved waits in cache/share until Selis restarts, then is gone; the
#        pack's theme is set only because the flow applied it (declined on the first pack).
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
#
# measure-pre:   (pack-measure.yaml) 50 one-page PDFs of ~6 MB in a protected pack (~300 MB,
#                made once in .tmp/p3-follow), pushed to Download/selis-measure; Selis cleared.
# measure-times: the import and export durations of the newest pack-measure run, from
#                Maestro's debug output (.tmp/maestro); then the pack is removed from the device.
set -euo pipefail
mode="${1:?usage: pack.sh pre|check|measure-pre|measure-times <serial>}"
serial="${2:?usage: pack.sh pre|check|measure-pre|measure-times <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
fixtures="$root/packages/fixtures/out"
packs="$root/.tmp/p3c/packs-$serial"
remote=/sdcard/Download/selis-fixtures
folder="content://com.android.externalstorage.documents/document/primary%3ADownload%2Fselis-fixtures"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

case "$mode" in
  pre)
    rm -rf "$packs"
    (cd "$root" && cargo run -q -p selis-core --example selispack -- make --theme sepia "$(win "$packs")" "correct horse" \
      "$(win "$fixtures/greek.pdf")" "$(win "$fixtures/mixed-sizes.pdf")" "$(win "$fixtures/acroform.pdf")")
    for f in plain protected tampered; do
      adb -s "$serial" push "$(win "$packs/$f.selispack")" "$remote/$f.selispack" >/dev/null
    done
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" shell am force-stop com.google.android.documentsui
    adb -s "$serial" shell am start -a android.intent.action.VIEW -t vnd.android.document/directory \
      -d "$folder" com.google.android.documentsui >/dev/null
    sleep 2
    ;;
  check)
    want="$(for f in greek mixed-sizes acroform; do
      (cd "$root" && cargo run -q -p selis-transfer --example selis-peer -- hash "$(win "$fixtures/$f.pdf")") | cut -d' ' -f1
    done | sort | tr '\n' ' ')"
    got="$(sh_app 'ls library/' | grep '\.pdf$' | sed 's/\.pdf$//' | sort | tr '\n' ' ')"
    if [ "$want" != "$got" ]; then
      echo "library files differ: got [$got] want [$want]"
      exit 1
    fi
    # The theme came from the pack only through "Apply" (security audit run-1, lead 4).
    db="$root/.tmp/p3c/db-$serial"
    rm -rf "$db" && mkdir -p "$db"
    for f in selis.db selis.db-wal; do
      adb -s "$serial" exec-out run-as "$app" cat "$f" > "$db/$f" 2>/dev/null || rm -f "$db/$f"
    done
    theme="$(python -I -c 'import sqlite3, sys; r = sqlite3.connect(sys.argv[1] + "/selis.db").execute("SELECT value FROM settings WHERE key = ?", ("theme",)).fetchone(); print(r[0] if r else "")' "$(win "$db")" | tr -d '\r')"
    if [ "$theme" != '"sepia"' ]; then
      echo "theme is [$theme], want the pack's \"sepia\" after Apply"
      exit 1
    fi
    left="$(sh_app 'ls pack-in 2>/dev/null; ls cache/share 2>/dev/null | grep import; true' | wc -l | tr -d ' ')"
    if [ "$left" != 0 ]; then
      echo "staging or import copies left behind ($left)"
      exit 1
    fi
    for f in plain protected tampered; do
      a="$(sha256sum "$packs/$f.selispack" | cut -d' ' -f1)"
      b="$(adb -s "$serial" shell sha256sum "$remote/$f.selispack" | cut -d' ' -f1 | tr -d '\r')"
      [ "$a" = "$b" ] || { echo "$f.selispack changed on the device"; exit 1; }
    done
    shared="$(sh_app 'ls cache/share 2>/dev/null' | grep -c '\.selispack$' || true)"
    if [ "$shared" != 1 ]; then
      echo "expected the saved pack in cache/share, found $shared"
      exit 1
    fi
    adb -s "$serial" shell am force-stop "$app"
    adb -s "$serial" shell am start -W -n "$app/.MainActivity" >/dev/null
    sleep 3
    shared="$(sh_app 'ls cache/share 2>/dev/null' | grep -c '\.selispack$' || true)"
    if [ "$shared" != 0 ]; then
      echo "the saved pack is still in cache/share after a restart"
      exit 1
    fi
    echo "library: exactly the 3 fixtures (BLAKE3 match), tampered pack added nothing, no leftovers, packs untouched, saved pack gone after restart, theme applied only on Apply"
    ;;
  measure-pre)
    work="$root/.tmp/p3-follow"
    if [ ! -f "$work/packs/protected.selispack" ]; then
      node "$(win "$here/make-measure-pdfs.ts")" "$(win "$work/docs")" 50 6000000
      # shellcheck disable=SC2046
      (cd "$root" && cargo run -q --release -p selis-core --example selispack -- make "$(win "$work/packs")"         "correct horse" $(for f in "$work"/docs/*.pdf; do win "$f"; done))
    fi
    adb -s "$serial" shell rm -rf /sdcard/Download/selis-measure
    adb -s "$serial" push "$(win "$work/packs/protected.selispack")" /sdcard/Download/selis-measure/measure-protected.selispack >/dev/null
    # The picker's search reads MediaStore: index the new file.
    adb -s "$serial" shell content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear "$app" >/dev/null
    ;;
  measure-times)
    node "$(win "$here/pack-measure-times.ts")" "$(win "$root/.tmp/maestro/.maestro/tests")"
    adb -s "$serial" shell rm -rf /sdcard/Download/selis-measure
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
