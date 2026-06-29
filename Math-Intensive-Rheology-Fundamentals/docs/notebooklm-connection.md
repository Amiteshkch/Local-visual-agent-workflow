# Connecting The Workbench To NotebookLM

This workbench does not call NotebookLM directly. NotebookLM has no stable public API for creating notebooks or pushing sources programmatically. The reliable connection is:

1. Export a NotebookLM-ready Markdown source from this workbench.
2. Let the file sync through Google Drive.
3. Add that Drive file as a source in the correct NotebookLM notebook.

The export button creates one source file per paper in:

```text
Math-Intensive-Rheology-Fundamentals/notebooklm_exports/
```

Because this project is inside Google Drive, those files can be selected from NotebookLM once Drive sync finishes.

## Per-Notebook Workflow

Use this when each NotebookLM notebook represents one paper, one book chapter, or one research topic.

1. Start the workbench:

   ```bash
   cd Math-Intensive-Rheology-Fundamentals
   python3 server.py
   ```

2. Open:

   ```text
   http://127.0.0.1:8000
   ```

3. Pick the paper from the left library.

4. Optional but recommended before export:

   - Run `Vision LaTeX` for the useful page range.
   - Build the derivation flow in the `Mathematics` tab.
   - Use Firecrawl references once for the paper/topic.

5. Click `NotebookLM source`.

6. The workbench writes a Markdown file like:

   ```text
   notebooklm_exports/<paper-id>-<title>-notebooklm.md
   ```

7. Wait for Google Drive to sync the file.

8. Open NotebookLM with the same Google account.

9. Create or open the target notebook.

10. Add source -> Google Drive -> select the exported Markdown file.

## Recommended Notebook Mapping

For clean retrieval, use one of these patterns.

### One Notebook Per Paper

Best for deep reading and equation-level questions.

Notebook name:

```text
<Author or Short Title> - Derivation Notes
```

Source:

```text
<paper-id>-<paper-title>-notebooklm.md
```

Use when you want NotebookLM to answer questions only from one paper.

### One Notebook Per Topic

Best for comparing multiple papers.

Notebook name:

```text
Capillary thinning and pinch-off
```

Sources:

```text
paper-1-notebooklm.md
paper-2-notebooklm.md
paper-3-notebooklm.md
```

Use when you want NotebookLM to synthesize across papers in the same domain.

### One Notebook Per Book Or Chapter Group

Best for textbooks and long scanned books.

Notebook name:

```text
Dynamics of Polymeric Liquids - Volume 1
```

Sources:

```text
book-id-chapter-01-notebooklm.md
book-id-chapter-02-notebooklm.md
book-id-chapter-03-notebooklm.md
```

If the source becomes too large, split by chapter or page range before exporting.

## What The Export Contains

Each Markdown source includes:

- paper metadata
- detected mathematical methods
- objective, assumptions, boundary conditions, and governing equations
- Vision LaTeX equations
- extracted equation text
- derivation dependency-flow edges
- Firecrawl web references
- extracted page text from the PDF

NotebookLM will treat this Markdown as a normal source document.

## Updating A Notebook Source

When a paper changes in the workbench:

1. Re-run the relevant scan or flow step.
2. Click `NotebookLM source` again.
3. The export file is overwritten with the same filename.
4. Wait for Google Drive to sync.
5. In NotebookLM, refresh or re-open the source if it does not update automatically.

Drive-backed sources usually update after sync, but NotebookLM can lag. If the old content remains, remove the source from the notebook and add the same Drive file again.

## Naming Rules

Export filenames use:

```text
<paper-id>-<sanitized-title>-notebooklm.md
```

Keep the generated filename. The paper id makes it stable even if two PDFs have similar titles.

For topic notebooks, do not rename files inside NotebookLM only. If you need a better display name, rename the Drive file itself after export or improve the paper title in the workbench.

## Limits And Practical Guidance

- NotebookLM cannot read `http://127.0.0.1:8000`; that address only exists on this Mac.
- NotebookLM will not preserve the interactive graph UI. It receives the graph as text edges.
- Large books should be split into chapter-level exports when possible.
- Keep one exported Markdown file under NotebookLM source limits.
- Do not paste API keys into exported sources.
- Use topic notebooks for synthesis, paper notebooks for precise citation-style work.

## Troubleshooting

### Export Button Is Missing

Reload the page at:

```text
http://127.0.0.1:8000
```

Then select a paper from the library. The `NotebookLM source` button appears in the paper header.

### Export Fails

Check that the Flask server is running and that the paper still exists in:

```text
uploads/library/<paper-id>/
```

Then retry the button.

### Firecrawl References Are Missing

The export still works. It will include a short Firecrawl error note instead of references.

To enable references, make sure Firecrawl is authenticated in the same environment that runs `server.py`.

### NotebookLM Cannot Find The File

Check that Google Drive has finished syncing:

```text
notebooklm_exports/
```

If the file is still local-only, wait for sync or manually upload the Markdown file to Google Drive.

### NotebookLM Shows Old Content

Re-open the notebook after Drive sync. If that is not enough, remove the old source and add the same Drive file again.

## Future Automation Path

If Google exposes a stable NotebookLM API later, the workbench can add a direct connector that:

1. creates or finds the target NotebookLM notebook,
2. uploads the exported Markdown source,
3. replaces older source versions,
4. stores the NotebookLM notebook id next to the paper id.

Until then, Google Drive is the safest supported bridge.
