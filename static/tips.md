# Tips and tricks

How to do things quickly in the tool.

## Working faster
- Fix the structure before the text: merging cells or inserting rows later moves text around.
- Click the image to pin the red row guide on the row you are reading; click again to remove it.
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

## Comparing while you edit (Compare ▾, top bar)
- Shows another source next to your table, without changing anything: its text, structure or boxes. The cells
  that differ are coloured on the right and marked with a corner in your table. Take a difference: click it (or
  drag over several), then Enter, **Take ←** or double-click.

## Cell boxes (box mode, Ctrl+E)
- A whole table at once: **Grid ▾**, and choose how it starts: "Lines from the cell boxes" (when the model gave
  boxes; drag the outer border and the inner lines follow) or "Uniform grid" (equal rows and columns; the rows ×
  columns fields set how many lines). Press **Snap** (the lines go onto the rulings, or into the gaps between rows
  of text), fix the lines that are wrong, then **Make boxes**. To change the lines again later: **▦ Back to grid**.
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
- A pre-annotation too wrong to fix: **New table…**, choose the size, keep the boxes: they are put on the new grid
  by their place. Off by a row or column: click one box, Move to cell…, type its cell, "all the boxes".
- A slanted or curved cell: switch **▭ Box** to **⬠ Polygon** and click its corners.
- Boxes missing here and there: in **↖ Select**, click an empty spot (or press Esc): nothing is selected. Then
  draw with **▭ Box** (or ⬠ Polygon): each new box goes to the cell at that place, and no box is replaced. Check
  the cell name it shows.
- Several boxes off by the same amount: in **↖ Select**, drag a rectangle over them (Ctrl+click adds one), then
  drag one of them: they all move. Delete removes them.
- A row or column with no boxes yet, next to one that has them: right-click a box of that one, "New row below,
  boxes the same size" (or above, left, right).
- The bar above the image says "model box", "grid box" or "box ✓" (drawn or fixed by hand) for the selected cell.
