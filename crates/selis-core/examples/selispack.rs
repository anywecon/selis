//! Dev tool for the `.selispack` device checks (apps/app/e2e/maestro/pack.sh,
//! scripts/measure-transfer.ts `pack`). Not shipped.
//!
//!   selispack make [--theme <theme>] <out-dir> <passphrase> <pdf>...
//!       plain.selispack, protected.selispack (with the passphrase) and
//!       tampered.selispack (protected, one body byte flipped) from a fresh
//!       library holding the given PDFs (and, with --theme, that theme setting:
//!       the receiving app then asks before applying it).
//!   selispack open <pack> [passphrase]
//!       imports into a fresh library and prints `documents=<n> blake3=<sorted hashes>`,
//!       or `refused=<problem>`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use selis_core::{Error, Library, LibraryQuery, PackRequest};

fn fresh_library(tag: &str) -> Result<(tempfile::TempDir, Library), String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let lib = Library::open(dir.path().join(tag)).map_err(|e| e.to_string())?;
    Ok((dir, lib))
}

fn make(out: &Path, passphrase: &str, pdfs: &[PathBuf], theme: Option<&str>) -> Result<(), String> {
    let (_dir, lib) = fresh_library("make")?;
    if let Some(theme) = theme {
        lib.set_setting("theme", &serde_json::json!(theme))
            .map_err(|e| e.to_string())?;
    }
    for pdf in pdfs {
        lib.import_path(pdf)
            .map_err(|e| format!("{}: {e}", pdf.display()))?;
    }
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let whole = |passphrase: Option<&str>| PackRequest {
        document_ids: None,
        include_history: true,
        passphrase: passphrase.map(str::to_owned),
    };
    lib.export_pack(&out.join("plain.selispack"), &whole(None))
        .map_err(|e| e.to_string())?;
    let protected = out.join("protected.selispack");
    lib.export_pack(&protected, &whole(Some(passphrase)))
        .map_err(|e| e.to_string())?;
    let mut bytes = std::fs::read(&protected).map_err(|e| e.to_string())?;
    let at = bytes.len() / 2;
    bytes[at] ^= 1;
    std::fs::write(out.join("tampered.selispack"), bytes).map_err(|e| e.to_string())?;
    println!(
        "made 3 packs with {} document(s) in {}",
        pdfs.len(),
        out.display()
    );
    Ok(())
}

fn open(pack: &Path, passphrase: Option<&str>) -> Result<(), String> {
    let (_dir, lib) = fresh_library("open")?;
    match lib.import_pack(pack, passphrase) {
        Ok(imported) => {
            let mut hashes: Vec<String> = lib
                .list_documents(&LibraryQuery::default())
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|d| d.blake3)
                .collect();
            hashes.sort();
            println!(
                "documents={} blake3={}",
                imported.document_ids.len(),
                hashes.join(",")
            );
            Ok(())
        }
        Err(Error::Pack(problem)) => {
            println!("refused={problem:?}");
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [cmd, flag, theme, out, passphrase, pdfs @ ..]
            if cmd == "make" && flag == "--theme" && !pdfs.is_empty() =>
        {
            make(
                Path::new(out),
                passphrase,
                &pdfs.iter().map(PathBuf::from).collect::<Vec<_>>(),
                Some(theme),
            )
        }
        [cmd, out, passphrase, pdfs @ ..] if cmd == "make" && !pdfs.is_empty() => make(
            Path::new(out),
            passphrase,
            &pdfs.iter().map(PathBuf::from).collect::<Vec<_>>(),
            None,
        ),
        [cmd, pack] if cmd == "open" => open(Path::new(pack), None),
        [cmd, pack, passphrase] if cmd == "open" => open(Path::new(pack), Some(passphrase)),
        _ => Err(
            "usage: selispack make [--theme <theme>] <out-dir> <passphrase> <pdf>... | open <pack> [passphrase]"
                .into(),
        ),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
