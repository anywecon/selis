//! Thin command wrappers: validate input → call `selis-core` → typed result.
//! No business logic lives here.

pub mod camera;
pub mod convert;
pub mod device;
pub mod library;
pub mod open_with;
pub mod pack;
pub mod photos;
pub mod picker;
pub mod requests;
pub mod save;
pub mod settings;
pub mod share;
pub mod signatures;
#[cfg(test)]
mod source_tests;
pub mod tags;
pub mod tools;
pub mod transfer;

use serde::Serialize;
use specta::Type;

/// Machine-readable error category; the UI maps it to a localized message.
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    NotPdf,
    EmptyFile,
    NotFound,
    Io,
    InvalidArgument,
    /// The name (e.g. of a tag) is already taken.
    Conflict,
    /// Not available on this platform (e.g. the native share sheet).
    Unsupported,
    /// The operation did not finish in time (nothing was written).
    Timeout,
    Internal,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: ErrorCode,
    /// Developer-facing detail, never shown verbatim to users.
    pub message: String,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<selis_core::Error> for CommandError {
    fn from(err: selis_core::Error) -> Self {
        use selis_core::Error as E;
        let code = match &err {
            E::NotPdf => ErrorCode::NotPdf,
            E::EmptyFile => ErrorCode::EmptyFile,
            E::NotFound(_) => ErrorCode::NotFound,
            E::Io { .. } => ErrorCode::Io,
            E::InvalidArgument(_) => ErrorCode::InvalidArgument,
            E::Conflict(_) => ErrorCode::Conflict,
            E::Db(_) | E::Json(_) | E::SchemaTooNew { .. } => ErrorCode::Internal,
            E::Pack(_) => ErrorCode::InvalidArgument,
        };
        Self::new(code, err.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;
