/**
 * Spreadsheet → Markdown Table Converter (M-P4).
 *
 * Turns a messy ad-hoc xlsx / csv into a GitHub-style markdown table that
 * `parseProse()` can extract tasks from. Column headers stay variable on
 * purpose — the LLM prompt in `proseExtractionPrompt.js` maps them to fields
 * heuristically.
 *
 * SheetJS is loaded lazily so the ~1MB `xlsx` bundle is only fetched when a
 * spreadsheet is actually uploaded — the rest of the app pays no cost.
 */

/**
 * Pure helper: take a 2D array of cell values (as SheetJS returns via
 * `sheet_to_json(..., { header: 1 })`) and emit a markdown table. Exported
 * so tests can cover the formatting logic without SheetJS in the harness.
 *
 * @param {Array<Array<string|number|null>>} rows - 2D cell matrix.
 *   `rows[0]` MUST be the header row. Blank rows should already be filtered.
 * @param {object} [opts]
 * @param {string} [opts.title] - Rendered as an H1 above the table.
 * @returns {string}
 */
export function rowsToMarkdownTable(rows, { title } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const lines = [];
  if (title) {
    lines.push(`# ${title}`);
    lines.push('');
  }
  const [header, ...dataRows] = rows;
  const width = header.length;
  const cell = (v) => {
    if (v == null) return '';
    return String(v).replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|').trim();
  };
  lines.push('| ' + header.map(cell).join(' | ') + ' |');
  lines.push('|' + Array(width).fill('---').join('|') + '|');
  for (const row of dataRows) {
    const padded = row.length === width ? row : [...row, ...Array(Math.max(0, width - row.length)).fill('')];
    lines.push('| ' + padded.slice(0, width).map(cell).join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * @typedef {Object} SpreadsheetToMarkdownResult
 * @property {string} markdown - GitHub-flavored markdown table string,
 *   with an H1 header line summarizing the sheet.
 * @property {string} sheetName - Name of the sheet picked.
 * @property {number} rowCount - Number of data rows included (excludes
 *   header and blank rows).
 * @property {string[]} columns - Raw header values as they appeared in the
 *   sheet (surfaced so the UI can show them in a confirmation dialog).
 */

/**
 * Convert an uploaded spreadsheet into a markdown table string.
 *
 * @param {ArrayBuffer | Uint8Array | Blob | File | string} input - Uploaded
 *   file. String inputs are treated as CSV.
 * @param {object} [options]
 * @param {string} [options.fileName] - Original filename for the H1 header
 *   line and error messages.
 * @param {string} [options.sheetName] - Force a specific sheet (skip the
 *   first-non-empty heuristic).
 * @returns {Promise<SpreadsheetToMarkdownResult>}
 */
export async function spreadsheetToMarkdown(input, options = {}) {
  if (input == null || input === '') {
    throw new Error('Unable to parse spreadsheet: input is empty.');
  }

  const XLSX = await loadXLSX();
  const workbook = await readWorkbook(XLSX, input);

  const sheetName = pickSheetName(workbook, options.sheetName);
  if (!sheetName) {
    throw new Error('Unable to parse spreadsheet: workbook contains no sheets.');
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Unable to parse spreadsheet: sheet "${sheetName}" not found.`);
  }

  // header: 1 → returns a 2D array of cell values, raw enough for our own
  // header detection (we don't trust the first physical row to be the header).
  // dateNF forces inferred dates to render as ISO so downstream extraction
  // sees "2026-04-23" rather than the locale-default "4/23/26".
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: false,
    dateNF: 'yyyy-mm-dd',
  });

  const rows = trimTrailingEmptyColumns(dropBlankRows(raw));
  if (rows.length === 0) {
    throw new Error(`Unable to parse spreadsheet: sheet "${sheetName}" has no data.`);
  }
  if (rows.length === 1) {
    throw new Error('Spreadsheet has no data rows after header.');
  }

  const fileName = options.fileName ? String(options.fileName).trim() : '';
  const titleParts = [];
  if (fileName) titleParts.push(fileName);
  titleParts.push(sheetName);
  const title = titleParts.join(' — ');

  const markdown = rowsToMarkdownTable(rows, { title });

  return {
    markdown,
    sheetName,
    rowCount: rows.length - 1,
    columns: rows[0].map((c) => (c == null ? '' : String(c).trim())),
  };
}

/**
 * Lazily import SheetJS. Cached after the first call.
 */
let xlsxModulePromise = null;
function loadXLSX() {
  if (!xlsxModulePromise) {
    xlsxModulePromise = import('xlsx').catch((err) => {
      xlsxModulePromise = null;
      throw new Error(`Unable to load xlsx library: ${err.message || err}`);
    });
  }
  return xlsxModulePromise;
}

async function readWorkbook(XLSX, input) {
  // cellDates: keep dates as Date objects so dateNF (yyyy-mm-dd) controls
  // rendering at sheet_to_json time; otherwise SheetJS bakes the locale's
  // M/D/YY format into cell.w and ignores dateNF on the way out.
  const readOpts = { cellDates: true, dateNF: 'yyyy-mm-dd' };
  try {
    if (typeof input === 'string') {
      return XLSX.read(input, { ...readOpts, type: 'string' });
    }
    if (input instanceof ArrayBuffer) {
      return XLSX.read(new Uint8Array(input), { ...readOpts, type: 'array' });
    }
    if (input instanceof Uint8Array) {
      return XLSX.read(input, { ...readOpts, type: 'array' });
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      const buf = await input.arrayBuffer();
      return XLSX.read(new Uint8Array(buf), { ...readOpts, type: 'array' });
    }
    if (input && typeof input.arrayBuffer === 'function') {
      const buf = await input.arrayBuffer();
      return XLSX.read(new Uint8Array(buf), { ...readOpts, type: 'array' });
    }
    throw new Error(`unsupported input type ${typeof input}`);
  } catch (err) {
    throw new Error(`Unable to parse spreadsheet: ${err.message || err}`);
  }
}

/**
 * Pick a sheet name. If `forced` is non-empty, demand it exists. Otherwise
 * return the first sheet whose data area has any non-empty cells.
 */
export function pickSheetName(workbook, forced) {
  if (!workbook || !Array.isArray(workbook.SheetNames)) return null;
  if (forced) {
    if (!workbook.SheetNames.includes(forced)) {
      throw new Error(`Sheet "${forced}" not found. Available: ${workbook.SheetNames.join(', ')}`);
    }
    return forced;
  }
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets?.[name];
    if (sheetHasContent(sheet)) return name;
  }
  return workbook.SheetNames[0] || null;
}

function sheetHasContent(sheet) {
  if (!sheet || typeof sheet !== 'object') return false;
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    const cell = sheet[key];
    if (cell && cell.v != null && String(cell.v).trim() !== '') return true;
  }
  return false;
}

/**
 * Pure helper extracted so tests can call it without SheetJS.
 */
export function dropBlankRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => Array.isArray(r) && r.some((cell) => cell != null && String(cell).trim() !== ''));
}

/**
 * Trim trailing columns that are empty across every row (header included).
 * Common with spreadsheets that have stray formatting in column ZZ.
 */
export function trimTrailingEmptyColumns(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  let lastUsed = -1;
  for (let col = 0; col < width; col += 1) {
    const colHasValue = rows.some((r) => {
      const v = Array.isArray(r) ? r[col] : undefined;
      return v != null && String(v).trim() !== '';
    });
    if (colHasValue) lastUsed = col;
  }
  if (lastUsed < 0) return [];
  if (lastUsed === width - 1) return rows;
  return rows.map((r) => (Array.isArray(r) ? r.slice(0, lastUsed + 1) : r));
}

export const __TEST_ONLY__ = { rowsToMarkdownTable, dropBlankRows, trimTrailingEmptyColumns, pickSheetName };
