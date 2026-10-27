# Explicit current paper sources

This optional local pipeline verifies a PDF linked by the current paper section
of an already downloaded official Info39 parent page. It does not publish by
default. Source validation is automated technical evidence; it is not human or
clinical review.

The v2 parent parser requires one indexed parent URL, one explicit current paper
PDF, matching complete current product identity and a complete raw DOM inventory.
Official historical paper and known historical electronic links remain recorded
in their original order as excluded history. They are never selected as current,
downloaded by this adapter, or added to the child text. Any role collision,
unclassified link, orphan paper, multiple current URLs or incomplete resource
inventory blocks the candidate. Historical and current URL aliases are checked
after decoding and query normalization.

The child PDF keeps the ordinary independent PDFJS, pdfplumber and pypdf ordered
text checks, physical page/image/structure checks, source identity, category and
runtime limits. Complete parent proof must fit 100,000 UTF-8 bytes; oversized
evidence is retained locally without truncation. Candidate inputs and manifests
are immutable, and publication batches contain at most 50 sources.

## Select only work that can add coverage

Wait for the main pipeline to finish before any parent publication. Plan offline
work from real acquired source records. Keep actual published licenses and
`main_direct_priority_pending` licenses as separate planning exclusions: pending
work is not published coverage. Never write a fabricated published protected set.
After main completion, use a fresh actual cloud pointer snapshot and recheck all
final main eligible licenses before preparing any remaining parent publication.

`--license-list` reads a JSON array containing 1–5000 unique complete license
identifiers, including the complete prefix and optional R code. It is mutually
exclusive with `--license`. The input file's actual path, byte SHA-256 and count
are recorded in the immutable summary; changing its bytes during evaluation
stops before manifests are written. The full parent branch inventory is still
loaded, so selecting a license cannot hide another branch.

```powershell
node --import tsx tools/prepare-tfda-parent-papers.ts `
  --inventory C:\tfda-cache\all-index `
  --corpus C:\tfda-cache\all-corpus `
  --archive C:\tfda-cache\asset-archive `
  --output C:\tfda-cache\parent-selected-v2 `
  --protected C:\tfda-cache\actual-published-snapshot.json `
  --license-list C:\tfda-cache\selected-complete-licenses.json `
  --limit 5000 --python C:\python\python.exe
```

Only the explicit publisher option `--parent-paper-mode strict-v2` authorizes
independent raw parent verification. The default rejects caller association
claims. The first v1 trial manifests remain offline evidence and must not be
published. Fresh raw replay, exact manifest/snapshot hashes, original protected
sources, create-only blobs and publication CAS checks apply to v2 as usual.
