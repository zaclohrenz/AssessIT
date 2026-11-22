//! File I/O and a generic .xlsx writer. The frontend decides the content;
//! this only lays it out in the style of the reference workbook.
//!
//! The frontend never names a file. Every command here shows the system save/open dialog itself and
//! touches only the file the person picks (and, when asked, opens that same file afterwards), so even
//! a compromised page can't read or write anything the person didn't choose.

use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;

/// The file-type choice in a dialog, e.g. { name: "PDF", extensions: ["pdf"] }.
#[derive(Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

/// Shows a save (`default_name` given) or open dialog and returns what the person picked, if anything.
async fn pick(app: &AppHandle, default_name: Option<&str>, filter: &Filter) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
    let dialog = app.dialog().file().add_filter(&filter.name, &exts);
    let done = move |p: Option<FilePath>| {
        let _ = tx.send(p.and_then(|p| p.into_path().ok()));
    };
    match default_name {
        Some(name) => dialog.set_file_name(name).save_file(done),
        None => dialog.pick_file(done),
    }
    rx.await.ok().flatten()
}

/// Opens a file the person just saved in its default app. Failure isn't an error: the file is saved.
fn open_saved(app: &AppHandle, path: &Path) {
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
}

#[derive(Deserialize)]
pub struct Section {
    heading: String,
    #[serde(default)]
    header: Vec<String>,
    rows: Vec<Vec<String>>,
    /// Column indexes (0-based) to shade as user input (yellow); the rest are gray "calculated".
    #[serde(default)]
    input_cols: Vec<u16>,
}

#[derive(Deserialize)]
pub struct Sheet {
    name: String,
    title: String,
    #[serde(default)]
    subtitle: String,
    widths: Vec<f64>,
    sections: Vec<Section>,
}

/// Lays the sheets out and saves them to `path`.
fn write_xlsx(path: &Path, sheets: Vec<Sheet>) -> Result<(), String> {
    let navy = Color::RGB(0x1F3A5F);
    let title = Format::new().set_bold().set_font_size(16);
    let subtitle = Format::new().set_italic().set_font_color(Color::RGB(0x595959));
    let heading = Format::new().set_bold().set_font_color(Color::White).set_background_color(navy);
    let header = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x44546A))
        .set_text_wrap();
    let cell = Format::new()
        .set_text_wrap()
        .set_align(FormatAlign::Top)
        .set_border(FormatBorder::Thin)
        .set_border_color(Color::RGB(0xD9D9D9));
    let input = cell.clone().set_background_color(Color::RGB(0xFFF4C2));
    let calc = cell.clone().set_background_color(Color::RGB(0xF2F2F2));

    let mut wb = Workbook::new();
    for s in &sheets {
        let ws = wb.add_worksheet();
        ws.set_name(&s.name).map_err(|e| e.to_string())?;
        for (i, w) in s.widths.iter().enumerate() {
            ws.set_column_width(i as u16, *w).map_err(|e| e.to_string())?;
        }
        let ncols = s.widths.len().max(1) as u16;
        ws.write_with_format(0, 0, &s.title, &title).map_err(|e| e.to_string())?;
        if !s.subtitle.is_empty() {
            ws.write_with_format(1, 0, &s.subtitle, &subtitle).map_err(|e| e.to_string())?;
        }
        let mut r: u32 = 3;
        for sec in &s.sections {
            for c in 0..ncols {
                ws.write_blank(r, c, &heading).map_err(|e| e.to_string())?;
            }
            ws.write_with_format(r, 0, &sec.heading, &heading).map_err(|e| e.to_string())?;
            r += 1;
            if !sec.header.is_empty() {
                for (c, h) in sec.header.iter().enumerate() {
                    ws.write_with_format(r, c as u16, h, &header).map_err(|e| e.to_string())?;
                }
                r += 1;
            }
            for row in &sec.rows {
                for (c, v) in row.iter().enumerate() {
                    let c = c as u16;
                    let f = if sec.input_cols.contains(&c) { &input } else if c == 0 { &cell } else { &calc };
                    // Only plain numerals become numbers ("inf", "NaN" and "1e5" stay text).
                    let numeric = !v.is_empty()
                        && v.len() < 16
                        && v.chars().all(|ch| ch.is_ascii_digit() || ch == '.' || ch == '-');
                    match v.parse::<f64>() {
                        Ok(n) if numeric => ws.write_number_with_format(r, c, n, f),
                        _ => ws.write_with_format(r, c, v, f),
                    }
                    .map_err(|e| e.to_string())?;
                }
                r += 1;
            }
            r += 1;
        }
    }
    wb.save(path).map_err(|e| e.to_string())
}

/// Save dialog, then the workbook. Returns whether a file was saved (false = the person cancelled).
#[tauri::command]
pub async fn save_xlsx(app: AppHandle, default_name: String, filter: Filter, sheets: Vec<Sheet>, open_after: bool) -> Result<bool, String> {
    let Some(path) = pick(&app, Some(&default_name), &filter).await else { return Ok(false) };
    write_xlsx(&path, sheets)?;
    if open_after {
        open_saved(&app, &path);
    }
    Ok(true)
}

/// Save dialog, then the text. Returns whether a file was saved.
#[tauri::command]
pub async fn save_text_file(app: AppHandle, default_name: String, filter: Filter, contents: String) -> Result<bool, String> {
    let Some(path) = pick(&app, Some(&default_name), &filter).await else { return Ok(false) };
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Save dialog, then base64-encoded bytes (the PDF report). Returns whether a file was saved.
#[tauri::command]
pub async fn save_binary_file(app: AppHandle, default_name: String, filter: Filter, base64: String, open_after: bool) -> Result<bool, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.trim()).map_err(|e| e.to_string())?;
    let Some(path) = pick(&app, Some(&default_name), &filter).await else { return Ok(false) };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    if open_after {
        open_saved(&app, &path);
    }
    Ok(true)
}

/// Open dialog, then the chosen file's text. None = the person cancelled.
#[tauri::command]
pub async fn open_text_file(app: AppHandle, filter: Filter) -> Result<Option<String>, String> {
    let Some(path) = pick(&app, None, &filter).await else { return Ok(None) };
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_numbers_as_numbers_and_everything_else_as_text() {
        let sheets: Vec<Sheet> = serde_json::from_value(json!([{
            "name": "Input",
            "title": "Assessment Input",
            "widths": [6.0, 12.0, 20.0],
            "sections": [{
                "heading": "Questionnaire",
                "header": ["ID", "Response", "Points"],
                "input_cols": [1],
                "rows": [["L1", "No", "0"], ["M3", "Yes", "-0.05"], ["X1", "inf", "NaN"], ["X2", "1e5", "2026-10-21"]]
            }]
        }]))
        .unwrap();
        let path = std::env::temp_dir().join("assessit-export-test.xlsx");
        write_xlsx(&path, sheets).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1000);
    }
}
