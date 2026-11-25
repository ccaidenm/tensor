// ─── TENSOR-NATIVE PRINTING — the OS dialog's replacement ──────────────
//
// THE POSTURE (#43): the document knows more than the OS — page
// size, orientation, margins, content — and the walk already
// synthesizes a geometrically exact PDF (pdfExport), so the
// pipeline is:
//     the walk → PDF bytes → temp file → CUPS job
// with LANDSCAPE INHERITING NATIVELY (the PDF carries the page dims).
//
// THE CRATE (printers 2.3): unix (CUPS) + windows (winspool). Its
// `print_file` submits through CUPS with raw job properties —
// `copies` and `sides` (duplex) are IPP/CUPS job options, spelled
// exactly as CUPS spells them:
//     one-sided | two-sided-long-edge | two-sided-short-edge
// `Converter::None` sends the PDF as-is; CUPS (cups-filters) rasterizes
// server-side. Ghostscript conversion stays available if a printer
// proves PDF-averse — not wired until a real machine needs it.
//
// THE COMMAND SURFACE (all the webview may invoke):
//     enumerate_printers() -> Vec<PrinterInfo>
//     print_pdf(printer, path, copies, duplex) -> job id
// Enumeration is sync and cheap (CUPS destination list); the webview
// calls it once per print-dialog open, never per keystroke.

use printers::common::base::job::PrinterJobOptions;
use printers::common::converters::Converter;
use printers::{get_printer_by_name, get_printers};

/// The webview's printer shape: display name, machine name, state,
/// and the human furniture (location/description) — everything the
/// Chrome-style picker shows, nothing it doesn't.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    /// Display name — the select's label AND the print command's key.
    pub name: String,
    /// Name exactly as the system spells it (the CUPS -d argument).
    pub system_name: String,
    /// READY | OFFLINE | PAUSED | PRINTING | UNKNOWN (lowercased).
    pub state: String,
    /// The system default — preselected in the picker.
    pub is_default: bool,
    /// e.g. "Office desk 2" — shown muted under the name.
    pub location: String,
    /// e.g. "HP LaserJet Pro M402" — shown muted under the name.
    pub description: String,
}

#[tauri::command]
pub fn enumerate_printers() -> Vec<PrinterInfo> {
    get_printers()
        .into_iter()
        .map(|p| PrinterInfo {
            name: p.name.clone(),
            system_name: p.system_name.clone(),
            state: format!("{:?}", p.state).to_lowercase(),
            is_default: p.is_default,
            location: p.location.clone(),
            description: p.description.clone(),
        })
        .collect()
}

/// Duplex, spelled as CUPS spells the `sides` job option. `default`
/// sends nothing — the printer's configured default stands.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DuplexOption {
    Default,
    OneSided,
    TwoSidedLongEdge,
    TwoSidedShortEdge,
}

impl DuplexOption {
    fn sides(&self) -> Option<&'static str> {
        match self {
            DuplexOption::Default => None,
            DuplexOption::OneSided => Some("one-sided"),
            DuplexOption::TwoSidedLongEdge => Some("two-sided-long-edge"),
            DuplexOption::TwoSidedShortEdge => Some("two-sided-short-edge"),
        }
    }
}

/// Submit a PDF file to a printer as a CUPS job. Returns the job id
/// (the toast's honest confirmation — never a silent "printed").
#[tauri::command]
pub fn print_pdf(
    printer: String,
    path: String,
    copies: u32,
    duplex: DuplexOption,
) -> Result<u64, String> {
    let printer = get_printer_by_name(&printer).ok_or_else(|| {
        format!("printer '{printer}' not found — it may have been removed or gone offline")
    })?;

    let copies_str = copies.to_string();
    let mut raw_properties: Vec<(&str, &str)> = vec![("copies", copies_str.as_str())];
    if let Some(sides) = duplex.sides() {
        raw_properties.push(("sides", sides));
    }

    let job_name = path.rsplit('/').next().unwrap_or("Tensor document");
    let options = PrinterJobOptions {
        // The job's name in the queue: the document, not "print job".
        name: Some(job_name),
        raw_properties: &raw_properties,
        converter: Converter::None,
    };

    printer.print_file(&path, options).map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplex_maps_to_cups_sides_spellings() {
        assert_eq!(DuplexOption::Default.sides(), None);
        assert_eq!(DuplexOption::OneSided.sides(), Some("one-sided"));
        assert_eq!(
            DuplexOption::TwoSidedLongEdge.sides(),
            Some("two-sided-long-edge")
        );
        assert_eq!(
            DuplexOption::TwoSidedShortEdge.sides(),
            Some("two-sided-short-edge")
        );
    }

    #[test]
    fn enumeration_returns_the_wire_shape() {
        // No printers on CI/the test container is legal (a fresh CUPS
        // with zero destinations); the WEBVIEW treats [] as "no
        // printers — fall back to the system dialog".
        for p in enumerate_printers() {
            assert!(!p.name.is_empty());
            assert!(["ready", "offline", "paused", "printing", "unknown"]
                .contains(&p.state.as_str()));
        }
    }
}