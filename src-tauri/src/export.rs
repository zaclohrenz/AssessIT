//! File I/O and a generic .xlsx writer. The frontend decides the content;
//! this only lays it out in the style of the reference workbook.

use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use serde::Deserialize;

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

#[tauri::command]
pub fn export_xlsx(path: String, sheets: Vec<Sheet>) -> Result<(), String> {
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
    wb.save(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Writes base64-encoded bytes (the PDF report) to disk.
#[tauri::command]
pub fn write_binary_file(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.trim()).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
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
        export_xlsx(path.to_string_lossy().into_owned(), sheets).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 1000);
    }
}
