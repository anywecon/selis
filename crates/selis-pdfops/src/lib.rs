//! PDF file operations on qpdf (P4a, ADR 0015): protect with a password (AES-256), remove the
//! password, compress (lossless), linearize, repair.
//!
//! Every operation goes file to file: qpdf reads objects lazily from the input and streams the
//! output, so a large file never sits in memory as a whole. The caller turns the output into a
//! new version (`selis_core`); nothing here touches the library.
//!
//! Passwords are [`Password`]s: wiped from memory when dropped, never printed by `Debug`.
//! qpdf copies them internally (the Rust wrapper's `String`/`CString`, C++ `std::string`);
//! those copies are freed after the call but not wiped (ADR 0015).

use std::fmt;
use std::path::Path;

use qpdf::{
    EncryptionParams, EncryptionParamsR6, ObjectStreamMode, PrintPermission, QPdf, QPdfWriter,
};
use qpdf::{QPdfError, QPdfErrorCode, QPdfObjectLike, QPdfObjectType, QPdfScalar, QPdfStream};
use qpdf::{StreamDataMode, StreamDecodeLevel};
use zeroize::Zeroizing;

/// The longest password AES-256 (revision 6) uses; qpdf would cut a longer one silently.
pub const MAX_PASSWORD_BYTES: usize = 127;

/// qpdf holds each stream it writes in memory (to know its length first), up to ~2.5× its size:
/// files are processed in constant memory except for their largest stream. A file with a single
/// stream above this is refused rather than risk the app being killed (ADR 0015).
pub const MAX_STREAM_BYTES: u64 = 512 * 1024 * 1024;

/// Why an operation did not produce a file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The file needs a password to open and none was given.
    #[error("the file is protected with a password")]
    PasswordNeeded,
    #[error("wrong password")]
    WrongPassword,
    /// The request does not fit the file or is invalid (e.g. removing a password the file does
    /// not have, restrictions without an owner password).
    #[error("invalid request: {0}")]
    InvalidArgument(&'static str),
    /// qpdf could not read the file even with recovery.
    #[error("damaged PDF: {0}")]
    Damaged(String),
    /// A PDF feature qpdf does not support (e.g. an unknown security handler).
    #[error("unsupported PDF: {0}")]
    Unsupported(String),
    #[error("i/o: {0}")]
    Io(String),
    /// A single stream larger than [`MAX_STREAM_BYTES`].
    #[error("a stream of {0} bytes is too large to process")]
    TooLarge(u64),
}

pub type Result<T> = std::result::Result<T, Error>;

fn from_qpdf(e: &QPdfError) -> Error {
    let detail = e.description().unwrap_or_default().to_owned();
    match e.error_code() {
        QPdfErrorCode::InvalidPassword => Error::WrongPassword,
        QPdfErrorCode::DamagedPdf | QPdfErrorCode::PagesError | QPdfErrorCode::ObjectError => {
            Error::Damaged(detail)
        }
        QPdfErrorCode::Unsupported => Error::Unsupported(detail),
        QPdfErrorCode::SystemError => Error::Io(detail),
        _ => Error::Damaged(detail),
    }
}

/// A password, wiped from memory when dropped.
pub struct Password(Zeroizing<String>);

impl Password {
    pub fn new(password: String) -> Self {
        Self(Zeroizing::new(password))
    }

    fn as_str(&self) -> &str {
        &self.0
    }

    fn check(&self) -> Result<()> {
        if self.0.is_empty() {
            return Err(Error::InvalidArgument("empty password"));
        }
        if self.0.len() > MAX_PASSWORD_BYTES {
            return Err(Error::InvalidArgument("password longer than 127 bytes"));
        }
        Ok(())
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(…)")
    }
}

/// What someone who opens the file with the open password may do. All `true` = no
/// restrictions (then no owner password is needed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permissions {
    pub print: bool,
    pub copy: bool,
    pub modify: bool,
}

impl Permissions {
    pub const ALL: Self = Self {
        print: true,
        copy: true,
        modify: true,
    };

    fn restricted(self) -> bool {
        self != Self::ALL
    }
}

#[derive(Debug)]
pub enum Operation {
    /// AES-256 (revision 6) only. `owner` is required when `permissions` restrict anything and
    /// must then differ from `open`.
    Protect {
        open: Password,
        owner: Option<Password>,
        permissions: Permissions,
    },
    /// Needs the password that opens the file.
    Unprotect { password: Password },
    /// Lossless: object streams, streams re-encoded with Flate, unreferenced objects dropped.
    Compress,
    /// "Fast web view": the first page can be shown before the whole file has arrived. Written
    /// without object streams (see `run`), so it can grow a little.
    Linearize,
    /// Rewrites the file from what qpdf recovers (rebuilt cross-reference table).
    Repair,
}

/// Who may open the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    None,
    /// Opens without a password but has an owner password (restrictions).
    Restricted,
    /// Needs a password to open.
    Password,
}

/// What an operation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// `output` was written.
    Written { input_bytes: u64, output_bytes: u64 },
    /// Nothing to do; `output` was not written (or was removed). No new version.
    Unchanged(Unchanged),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unchanged {
    /// Compressing did not make the file smaller.
    NotSmaller {
        input_bytes: u64,
    },
    AlreadyLinearized,
    /// qpdf read the file without a single warning: there is nothing to repair.
    NothingToRepair,
}

fn size(path: &Path) -> Result<u64> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| Error::Io(format!("{}: {e}", path.display())))
}

fn open(path: &Path, password: Option<&Password>) -> Result<QPdf> {
    let read = match password {
        Some(p) => QPdf::read_encrypted(path, p.as_str()),
        None => QPdf::read(path),
    };
    match read {
        Ok(doc) => Ok(doc),
        Err(e) if e.error_code() == QPdfErrorCode::InvalidPassword && password.is_none() => {
            Err(Error::PasswordNeeded)
        }
        Err(e) => Err(from_qpdf(&e)),
    }
}

/// The largest stream's declared length (its `/Length`), objects of generation 0.
///
/// The ids walked are bounded by what qpdf can have parsed, not by the trailer's `/Size` alone
/// (the file declares it, up to `u32::MAX`): qpdf ignores every object id above a third of the
/// file size (`xref_table_max_id`, QPDF_objects.cc), so no id beyond that can name an object.
fn largest_stream(doc: &QPdf, input_bytes: u64) -> u64 {
    let declared = doc
        .get_trailer()
        .and_then(|t| t.get("/Size"))
        .filter(|s| s.get_type() == QPdfObjectType::Integer)
        .map_or(0, |s| QPdfScalar::from(s).as_u64());
    let count = declared.min(input_bytes / 3 + 1);
    let mut largest = 0;
    for id in 1..u32::try_from(count).unwrap_or(u32::MAX) {
        let Some(object) = doc.get_object_by_id(id, 0) else {
            continue;
        };
        if object.get_type() != QPdfObjectType::Stream {
            continue;
        }
        if let Some(length) = QPdfStream::from(object).get_dictionary().get("/Length")
            && length.get_type() == QPdfObjectType::Integer
        {
            largest = largest.max(QPdfScalar::from(length).as_u64());
        }
    }
    largest
}

/// Writes `doc` to `output` with the writer set up by `configure`, then lets go of both: qpdf
/// keeps the output file open until the document is freed (Windows then refuses to open it
/// again for the checks below).
fn write(doc: QPdf, output: &Path, configure: impl FnOnce(&mut QPdfWriter)) -> Result<()> {
    let mut writer = doc.writer();
    configure(&mut writer);
    let written = writer.write(output).map_err(|e| from_qpdf(&e));
    drop(writer);
    drop(doc);
    written
}

/// Whether (and how) the file is protected.
pub fn protection(path: &Path) -> Result<Protection> {
    match open(path, None) {
        Ok(doc) if doc.is_encrypted() => Ok(Protection::Restricted),
        Ok(_) => Ok(Protection::None),
        Err(Error::PasswordNeeded) => Ok(Protection::Password),
        Err(e) => Err(e),
    }
}

/// Reads every object and decodes every stream (as `qpdf --check`).
pub fn check(path: &Path, password: Option<&Password>) -> Result<()> {
    let doc = open(path, password)?;
    doc.check_pdf().map_err(|e| from_qpdf(&e))?;
    if doc.more_warnings() {
        return Err(Error::Damaged("qpdf --check reported warnings".into()));
    }
    Ok(())
}

/// Runs `op` on `input`, writing `output` (replaced if it exists). On an error or an
/// [`Outcome::Unchanged`] no `output` is left behind.
pub fn run(input: &Path, output: &Path, op: &Operation) -> Result<Outcome> {
    run_with_limit(input, output, op, MAX_STREAM_BYTES)
}

/// [`run`] with another stream limit (tests).
pub fn run_with_limit(
    input: &Path,
    output: &Path,
    op: &Operation,
    max_stream_bytes: u64,
) -> Result<Outcome> {
    let result = run_inner(input, output, op, max_stream_bytes);
    if !matches!(result, Ok(Outcome::Written { .. })) {
        let _ = std::fs::remove_file(output);
    }
    result
}

fn run_inner(
    input: &Path,
    output: &Path,
    op: &Operation,
    max_stream_bytes: u64,
) -> Result<Outcome> {
    let input_bytes = size(input)?;
    let open = |path: &Path, password: Option<&Password>| -> Result<QPdf> {
        let doc = open(path, password)?;
        if path == input {
            let largest = largest_stream(&doc, input_bytes);
            if largest > max_stream_bytes {
                return Err(Error::TooLarge(largest));
            }
        }
        Ok(doc)
    };
    match op {
        Operation::Protect {
            open: open_password,
            owner,
            permissions,
        } => {
            open_password.check()?;
            if let Some(owner) = owner {
                owner.check()?;
            }
            let owner_password = match owner {
                Some(owner)
                    if owner.as_str() == open_password.as_str() && permissions.restricted() =>
                {
                    return Err(Error::InvalidArgument(
                        "the owner password must differ from the open password",
                    ));
                }
                Some(owner) => Zeroizing::new(owner.as_str().to_owned()),
                None if permissions.restricted() => {
                    return Err(Error::InvalidArgument(
                        "restrictions need an owner password",
                    ));
                }
                // No restrictions: whoever opens the file may do everything anyway.
                None => Zeroizing::new(open_password.as_str().to_owned()),
            };
            let doc = open(input, None)?;
            write(doc, output, |writer| {
                writer.encryption_params(EncryptionParams::R6(EncryptionParamsR6 {
                    user_password: open_password.as_str().to_owned(),
                    owner_password: owner_password.as_str().to_owned(),
                    allow_accessibility: true,
                    allow_extract: permissions.copy,
                    allow_assemble: permissions.modify,
                    allow_annotate_and_form: permissions.modify,
                    allow_form_filling: permissions.modify,
                    allow_modify_other: permissions.modify,
                    allow_print: if permissions.print {
                        PrintPermission::Full
                    } else {
                        PrintPermission::None
                    },
                    encrypt_metadata: true,
                }));
            })?;
            // The new file opens with the new password (and not without it).
            if open(output, None).is_ok() {
                return Err(Error::Unsupported(
                    "the written file opens without a password".into(),
                ));
            }
            open(output, Some(open_password))?;
        }
        Operation::Unprotect { password } => {
            password.check()?;
            match open(input, None) {
                Ok(doc) if !doc.is_encrypted() => {
                    return Err(Error::InvalidArgument("the file has no password"));
                }
                Ok(_) => return Err(Error::InvalidArgument("the file opens without a password")),
                Err(Error::PasswordNeeded) => {}
                Err(e) => return Err(e),
            }
            let doc = open(input, Some(password))?;
            write(doc, output, |writer| {
                writer.preserve_encryption(false);
            })?;
            open(output, None)?;
        }
        Operation::Compress => {
            let doc = open(input, None)?;
            write(doc, output, |writer| {
                writer
                    .object_stream_mode(ObjectStreamMode::Generate)
                    .compress_streams(true)
                    .stream_data_mode(StreamDataMode::Compress)
                    // Decodes LZW/ASCII85/ASCIIHex/RunLength and Flate, re-encodes with Flate;
                    // images (DCT, JPX, CCITT, JBIG2) stay as they are: lossless.
                    .stream_decode_level(StreamDecodeLevel::Generalized)
                    .preserve_unreferenced_objects(false);
            })?;
            open(output, None)?;
            let output_bytes = size(output)?;
            if output_bytes >= input_bytes {
                return Ok(Outcome::Unchanged(Unchanged::NotSmaller { input_bytes }));
            }
            return Ok(Outcome::Written {
                input_bytes,
                output_bytes,
            });
        }
        Operation::Linearize => {
            let doc = open(input, None)?;
            if doc.is_linearized() {
                return Ok(Outcome::Unchanged(Unchanged::AlreadyLinearized));
            }
            // qpdf 12.4 writes wrong outline hints when a linearized file keeps object streams
            // (`qpdf --check` warns; seen with the 1000-page fixture after Compress).
            write(doc, output, |writer| {
                writer
                    .linearize(true)
                    .object_stream_mode(ObjectStreamMode::Disable);
            })?;
            if !open(output, None)?.is_linearized() {
                return Err(Error::Unsupported(
                    "the written file is not linearized".into(),
                ));
            }
        }
        Operation::Repair => {
            let doc = open(input, None)?;
            // Warnings are what recovery fixed (or could not); a stream that does not decode
            // fails the check. Neither: a sound file, nothing to repair.
            let checked = doc.check_pdf().is_ok();
            if checked && !doc.more_warnings() {
                return Ok(Outcome::Unchanged(Unchanged::NothingToRepair));
            }
            write(doc, output, |_| {})?;
            open(output, None)?;
        }
    }
    Ok(Outcome::Written {
        input_bytes,
        output_bytes: size(output)?,
    })
}
