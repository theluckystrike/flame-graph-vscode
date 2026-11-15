# Find the slow code

- Each bar is a function. Its width is the time (or memory) spent in it and in everything it called.
- Left heavy merges identical call paths and puts the heaviest on the left. Time order keeps the samples as they happened.
- Type in Search to light up a function or a file. The toolbar shows what share of the total it takes.
- Click a bar to zoom in. Escape or Reset zoom shows the whole profile again.
- Ctrl or Cmd + click a bar, or double-click a row of the table, to open its source line beside the graph.
- A pprof file can hold several sample types (CPU, samples, alloc_space, inuse_space). Pick one at the top.
