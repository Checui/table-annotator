# Tips and tricks

How to do things quickly in the tool.

## Working faster
- Fix the structure before the text: merging cells or inserting rows later moves text around.
- Click the image to pin the red row guide on the row you are reading; click again to remove it.
- **Show boxes** (View, above the image): untick it to see the page without the boxes. In box mode and in the grid
  it is **Show boxes** / **Show lines**. **Ctrl+H** does the same anywhere: tap it to hide or show, hold it to hide
  them only while you hold it. Right-click "Show boxes" (or ☀ Display ▾) to choose another key.
- **⇆ Layout** puts the image above the table, useful for wide tables.
- **Ctrl+Enter**: done, next table. **Ctrl+Z** undoes anything, the structure too.
- Right-click a cell: every structure operation in one menu.
- Copy and paste work with Excel; one value pasted on a selection fills every selected cell.
- Unclear reading: **Ctrl+U**. Header cell: **Ctrl+B**.

## Special characters, superscripts, formulas
- **Ω Symbols ▾** (above the table, right): click a symbol to put it in the cell; while you edit, it goes at the
  cursor. Type in Find (moon, fraction, 263D) and Enter puts the first one found. Add your own at the bottom, or
  with **+** on a symbol; **×** removes one of yours. **Alt+1** … **Alt+9**: the first nine.
- Fractions: ½ ¼ ¾ … in Ω Symbols ▾ (or Alt+2, Alt+3…) put the LaTeX formula, `$\frac{1}{2}$`. A fraction
  character typed or pasted, or found in an imported table, becomes its formula when the cell is saved.
- Superscript / subscript: while you edit, select the characters and click **x²** / **x₂** (**Ctrl+.** /
  **Ctrl+,**). The same again takes it off. With nothing selected, it starts one at the cursor.
- Formula: select it and click **ƒ(x)**, or type the dollar signs yourself. Hover a formula to see its LaTeX;
  a wrong one is red.

## Importing another annotation (Import ▾, top bar)
- Choose a source of the batch, or **From a file…** (an annotation JSON, an HTML table, PAGE XML, CSV / TSV), then
  what to take: **Only the text**, **Structure and text**, **Only the structure** (your text goes into the new
  cells) or **Only the boxes**.
- Nothing changes before you press the button: the window shows the image, your table now and the table after
  the import. Changed cells are green. Click a cell (or a column letter, a row number) to leave its change out;
  **Take all**, **Take none**, **Only where mine is empty**. For several at once, drag a rectangle over the cells
  or the image, then Enter: the first Enter leaves them all out, the next one takes them all. Red cells in "Now"
  are your text that the new table has no place for. Ctrl+Z undoes an import.
- Your work is saved apart, in your own folder under annotations: the sources are never changed. To go back to
  a source's boxes or text after changing them, choose that source again, even the one the table comes from,
  and take **Only the boxes** (or Box mode, More ▾, **Take the boxes of …**).

- The same mistake in many cells (a letter the model always reads wrong): select the cells (a column: click its
  letter), **Ctrl+Shift+F**, type what to find and what to put instead. "Only cells that are exactly this text" leaves
  longer texts alone. One value for many cells (a ditto mark down a column): copy it, select the cells, paste.

## Comparing while you edit (Compare ▾, top bar)
- Shows another source next to your table, without changing anything: its text, structure or boxes. The cells
  that differ are coloured on the right and marked with a corner in your table. Take a difference: click it (or
  drag over several), then Enter, **Take ←** or double-click.
- Too narrow or too wide? Drag the left border of the comparison (kept in this browser); double-click it for half
  and half.

## Cell boxes (box mode, Ctrl+E)
- In box mode a cell that still needs its box has a blue corner at the bottom right. Ctrl+E keeps the zoom and the
  place on the image, both ways.
- A whole table at once: **Grid ▾**, and choose how it starts: "Lines from the cell boxes" (when the model gave
  boxes; drag the outer border and the inner lines follow) or "Uniform grid" (equal rows and columns; the rows ×
  columns fields set how many lines). Press **Snap** (the lines go onto the rulings, or into the gaps between rows
  of text), then fix the lines that are wrong: the boxes follow the lines at once and are saved, nothing to press.
  **Close grid** (Enter or Esc) when it looks right; **Cancel** puts the boxes back as they were. To change the lines
  again later: **▦ Back to grid**.
- Grid with fewer rows than the table? The grid bar asks: **Keep the table** (the rows the grid has get their
  boxes, the others none for now; Done lists them) or **Make the table match…** (you pick the rows to delete, or
  to merge into the row above).
- Too many lines (more rows than the table)? **✕ Remove lines** in the grid bar, then click each line to remove:
  the other lines stay where they are (a border too: the next line becomes the border). Esc when done.
- A row or column line missing in the grid: right-click inside the grid where it goes, **Add a column line here**
  (or row): the other lines stay where they are, and the table gets the new empty column too. Right-click a line
  that should not be there: **Remove this line**.
- The rows × columns fields add or remove rows and columns at the bottom and on the right (**Options ▾** of the
  grid bar: top or left instead): your other lines stay, and the table gets the new empty row too. **Options ▾**, "Move
  all lines…", spreads all the lines evenly instead. **Even** spaces them evenly at any time. The Options button is
  blue when one of its settings is not the usual one.
- **Options ▾**, "Keep the boxes I drew or fixed by hand": ticked, the boxes you drew, moved or resized ("box ✓"
  above the image) stay as they are when the lines move; unticked, the lines give every cell its box, yours too. The
  panel says how many such boxes the table has.
- The grid shows the merged cells of the table: a light tint over each one, and the parts of the lines inside it are
  dotted (no border there in the table). The hint under the image names the merged cell under the pointer. Shown
  while the grid has the size of the table.
- Merge or split right there, with a right-click in the grid: on a line between two cells, **Merge across this
  line**; on a dotted part or inside a merged cell, **Split**; inside a cell, **Merge with the cell above / below /
  on the left / on the right**. The boxes follow the lines, Ctrl+Z undoes it. (**Remove this row line** is not the
  same: it joins the two whole rows.)
- Moving a line: drag it, or drag anywhere near it (up or down moves the nearest row line, left or right the
  nearest column line; the lines that would move are dashed). To place it exactly: click it, then the arrow keys.
- Your own keys for the actions: **⌨** (top right, next to **?**). Copy, paste, undo and moving in the table stay as
  they are.
- Page tilted: tilt the top border (drag its round end), then **Options ▾**, **Moved lines parallel to** top · left
  border: each line you drag takes the tilt of that border (rows: top or bottom, columns: left or right). "—" leaves
  the tilt of each line as it is.
- Fix single boxes by dragging their edges: a border shared with the next box moves for both (hold **Alt** to
  move one box alone).
- A box on the wrong cell: select that cell, **Move to cell…**, then type the right cell (e.g. E5) or click it in
  the table. When all the boxes from there on are one column (or row) off, choose "this box and the boxes after
  it": they all shift the same way. Tick **names** to see the cell name in each box.
- Two boxes that are one cell: Shift+click the second box, then **Merge** (Ctrl+M).
- Drawing by hand: keep **magnet** ticked. A box drawn next to another sticks to it (no gap, no overlap), and
  polygon points stick to the corners of the boxes around them.
- Cells that should not be there (the text after them is one cell off): select them, **Cells ✕**, "move the cells
  on the right to the left" (or the cells below up). The boxes stay at their place.
- A pre-annotation too wrong to fix: **Import ▾**, **New empty table…**, choose the size, keep the boxes: they are
  put on the new grid by their place. Off by a row or column: click one box, Move to cell…, type its cell, "all the boxes".
- A slanted or curved cell: switch **▭ Box** to **⬠ Polygon** and click its corners.
- Boxes missing here and there: in **↖ Select**, click an empty spot (or press Esc): nothing is selected. Then
  draw with **▭ Box** (or ⬠ Polygon): each new box goes to the cell at that place, and no box is replaced. Check
  the cell name it shows.
- Several boxes off by the same amount: in **↖ Select**, drag a rectangle over them (Ctrl+click adds one), then
  drag one of them: they all move. Delete removes them.
- A row or column with no boxes yet, next to one that has them: right-click a box of that one, "New row below,
  boxes the same size" (or above, left, right).
- The bar above the image says "model box", "grid box" or "box ✓" (drawn or fixed by hand) for the selected cell.
