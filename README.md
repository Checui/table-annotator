# Table annotation

A browser tool to correct tables against their image: the structure (rows, columns, merged cells, header cells),
the text of each cell and the box of each cell. Start from a model's answer (an HTML table, or JSON cells with
boxes) or from an empty grid, and fix it cell by cell, keyboard first, like a spreadsheet.

**Open the tool:** the website of this repository (GitHub Pages). It runs entirely in your browser.

## Nothing is uploaded

The page opens a folder on your own computer, reads the images and the model answers there, and saves your work
into that same folder. No file leaves your computer: the website only delivers the page itself. This uses the
browser's folder access, available in **Chrome** and **Edge** on a computer (not Firefox or Safari). The browser asks
you once to allow the page to edit the folder.

## Try it

- **Try the example** on the start page: four tables from the HisClima dataset, opened straight from the website.
  Changes are kept only until you reload the page.
- **Download the example folder** (`example.zip`), unzip it, then **Open a batch folder…** and pick it: now your work
  is saved in `annotations/<your name>/` inside it.

## A batch folder

```
<batch>/
├── images/               one image per table (PNG, JPEG or WEBP), named <table_id>.<ext>
├── tasks.csv             optional: table_id, image, group, assigned_to, note (which tables, in which order, for whom)
├── batch.json            optional: name, sources (order), prefill, special_chars, boxes, box_prefill, box_formats
├── pre/<source>/         optional: each model's answer per table, <table_id>.html (or .txt holding an HTML table)
│                         or <table_id>.json (cells with boxes)
└── annotations/<name>/   written by the tool: <table_id>.json and <table_id>.html, _log.jsonl, _history/
```

Several people can work on the same batch: each one's work goes to their own `annotations/<name>/` folder, so
nobody overwrites anybody, and the model answers are never modified. To share a batch, send the folder (zip), or
keep it in a cloud folder (OneDrive, Google Drive, Nextcloud…) that syncs to everyone's computer; then send back,
or let the cloud sync, your `annotations/<name>/` folder.

## Pre-annotations (input)

One folder per model, `pre/<model>/`, one file per table named `<table_id>.html`, `.txt` or `.json` (the table id
is the image's file name without its extension). With no `pre/` folder, the tool starts from an empty grid.

- **HTML** (`.html`, or a model's raw answer as `.txt`): the first `<table>` is read. `th` = header cell,
  `rowspan` / `colspan` = merged cells, `<br>` = space, `<sup>` / `<sub>` are kept, other tags are dropped. A cell
  can carry its box: `data-bbox="x0 y0 x1 y1"` (or hOCR `title="bbox x0 y0 x1 y1"`).
- **JSON** (`.json`), the same form as the output:

  ```json
  {"n_rows": 2, "n_cols": 2, "cells": [
    {"row": 0, "col": 0, "rowspan": 1, "colspan": 2, "text": "Hour", "header": true, "bbox": [10, 8, 400, 40]},
    {"row": 1, "col": 0, "rowspan": 1, "colspan": 1, "text": "1"},
    {"row": 1, "col": 1, "rowspan": 1, "colspan": 1, "text": "30.02", "polygon": [[200, 40], [400, 41], [400, 70], [200, 69]]}
  ]}
  ```

  Rows and columns count from 0. A model's raw JSON answer, saved as `.json`, is read too: inside a
  ```` ```json ```` fence, with `row_span` / `col_span` or a `box_2d` / `bbox_2d` box, or cut off (read up to its
  last whole cell). Its mistakes are fixed as for HTML: missing rows and columns counted, overlapping cells cut,
  missing cells added (shown striped).
- Boxes are in pixels of the table image. For boxes on a 0–1000 scale, set in `batch.json`
  `"box_formats": {"<model>": "norm1000"}` (`[x0, y0, x1, y1]`) or `"gemini"` (`[ymin, xmin, ymax, xmax]`).
- Inside the tool, **Import ▾ → From a file…** also reads PAGE XML (TableRegion > TableCell) and CSV / TSV, one
  table at a time, and shows the changes before taking them.

## Output

In `annotations/<your name>/`:

- `<table_id>.json` (`schema: haikido-table-annotation/1`): `status` (`in_progress`, `done`, `skipped`),
  `skip_reason`, `flagged`, `comment`, `started_from` (which pre-annotation, its sha256), `n_rows`, `n_cols`,
  `time_active_s`, `edit_counts`, `image_size`, `image_sha256`, `grid_lines`, and one line per cell: `row`, `col`,
  `rowspan`, `colspan`, `text`, `header`, `unclear`, `edited`, and the box `bbox` `[x0, y0, x1, y1]` / `polygon`
  `[[x, y], …]` in pixels with `box_by` (`model`, `grid` or `hand`).
- `<table_id>.html`: the same table as plain `<table>` / `<tr>` / `<td>` / `<th>` with `rowspan` and `colspan`.
- `_log.jsonl` (one line per save) and `_history/` (earlier versions).

Cell text is plain text; superscript and subscript are written `<sup>…</sup>` and `<sub>…</sub>`, formulas in LaTeX
between dollar signs (`$\frac{1}{2}$`).

## Keys

Press **?** or **Ctrl+/** in the tool for all the keys and what the colours mean. A few: arrows and Tab move, typing
replaces the cell's text, Enter edits it, Ctrl+M merges, Ctrl+Shift+arrows insert rows or columns, Ctrl+Z undoes,
Ctrl+E switches box mode, Ctrl+Enter marks the table as done and opens the next one.

## License and credits

- The tool's code: MIT license, see `LICENSE`. The example data keeps its own license (below).
- Example tables: **HisClima v2** (weather logbooks of the USS Jeannette, 1879–1881, and of the Albatross), Zenodo,
  [doi:10.5281/zenodo.7442971](https://doi.org/10.5281/zenodo.7442971), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The example holds four validation tables, cropped from
  the page and converted to JPEG; `pre/hisclima-gt/` is the dataset's own table annotation converted to cells
  with boxes, `pre/opus-5-5/` a vision-language model's answer.
- Formulas are drawn with [KaTeX](https://katex.org) (MIT license, `static/vendor/katex/LICENSE`).
