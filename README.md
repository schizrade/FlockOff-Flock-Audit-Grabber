# FlockOff CSV Grabber

A Chrome extension that collects the public audit CSVs from Flock Safety
transparency portals and merges them into one file per dataset.

It runs inside your own Chrome, in your normal session. There is no automation
driver and no remote-control protocol, so there is nothing for a bot check to
detect.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the icon to your toolbar.

Nothing installs system-wide. Deleting the folder removes it.

## Use

1. Click the icon and load your portal URLs, then click **Start run**. Three ways
   to get them in:
   - **Upload URL list (.txt)** pick one or more text files, one URL per line.
   - **Drop a file** onto the URL box.
   - **Paste** them straight in.

   Imports add to what's already listed and skip anything already there, so you
   can pull in several files. **Clear** empties the box. The list is remembered
   between sessions.
2. Chrome opens one tab and works down the list. The ledger shows where the run
   is, what it found, and how many files came back per portal.
3. If a security check appears, the row turns amber and a banner offers to open
   the tab. Solve the check there. The run notices and continues on its own —
   the per-portal clock stops while you're working, so it won't time out on you.
4. When the run ends, merged files land in **Downloads/Flock**.

You can pause, skip a stubborn portal, or stop at any point. Collected data is
kept until you clear it, so **Save merged CSV** works after the fact and across
multiple runs.

### Running again

When a run ends, press **New run** to clear the ledger and get back to the URL
list. Collected data survives, so you can run a short list of the portals that
failed and merge the whole set afterwards. Re-pulling an agency **replaces** its
earlier rows in the merged file rather than stacking on top of them, so a
partial re-run is always safe. The library takes the same re-run and keeps only
the rows it did not already have.

### Import file format

One full URL per line, starting with `https://`:

```
https://transparency.flocksafety.com/monrovia-ca-pd
https://transparency.flocksafety.com/redlands-ca-pd
```

Blank lines, comment lines, and trailing commas are ignored, and any file with
URLs embedded in it works too. A config block with `"Monrovia_PD": "https://…"`
per line imports fine. Windows or Unix line endings both work.

On some systems Chrome closes the popup when the file picker opens. If that
happens, use **Open this in a tab** and import from there. It is the same
screen, and your list carries over.

## What you get

In `Downloads/Flock`:

| File | What's in it |
| --- | --- |
| `merged__<dataset>__<date>.csv` | Every agency's rows for that dataset, stacked, with `agency`, `agency_url`, and `captured_at` columns added |
| `<agency>__<dataset>.csv` | Each portal's raw file, untouched, if "Save each file separately" is on |
| `run-log__<date>.csv` | One row per portal: status, attempts, files collected, and why anything failed |

Datasets are grouped by the heading above the download button, so **Public
Search Audit** from ten agencies becomes one file. Agencies publishing different
columns are handled. The merged header is the union, and missing cells are left
blank rather than shifted.

## The data library

Everything collected also goes into a library that lives inside the extension
and persists across runs. Open it with **Library** in the popup, or from the
extension's entry on `chrome://extensions`.

The library is the durable copy; the files in `Downloads/Flock` are snapshots of
it. Press **Save workbook** and it builds a fresh `.xlsx` from everything held:

| Sheet | What's in it |
| --- | --- |
| `Index` | Every dataset: rows, how many agencies report it, how many columns, dates |
| `Coverage` | One row per agency, one column per dataset, counts in the cells |
| `Runs` | Run history |
| One per dataset | Every agency's rows stacked, with `agency`, `source_file`, `first_seen`, `run_id` ahead of the published columns |

Datasets get a sheet each rather than agencies. A question that spans agencies, 
who ran the most searches without a case number, is then a filter rather than
ten copy-pastes. `Coverage` is the per-agency view, and its zeroes are the point:
they tell you which portal still owes you which dataset.

Numeric values are written as real numbers so they sort and total, while
identifiers like `25-001` and `007` stay text. Row order is stable, so two
workbooks saved a week apart can be diffed against each other.

**Save CSVs** gives the same content as one CSV per dataset in a zip.

### Why it doesn't append to the workbook

An `.xlsx` is a zip of XML documents. Appending to one means unzipping, parsing
every sheet, merging, and rewriting the whole file, and an extension cannot
reopen a file it wrote to your Downloads folder last week. The workbook would be
both the only copy of the data and the thing most likely to be half-written.

So rows are stored inside the extension instead, each keyed by a fingerprint of
its own contents, and the workbook is rebuilt from scratch every time you ask
for one. That buys three things:

- **Re-pulling a portal is free.** The same rows produce the same fingerprints
  and are recognised as already held. Row counts only move by what is new.
- **A run that dies halfway costs nothing.** Run it again; the gaps fill in and
  nothing doubles.
- **Deleting a workbook loses nothing.** Save another.

### Back it up

The library is stored by Chrome under this extension. **Remove the extension and
it goes with it.** Press **Save backup** occasionally and keep the file
somewhere. Restoring is exact, same fingerprints, so restoring the same backup
twice adds nothing the second time, and restoring over a library you have been
adding to merges rather than overwrites.

### Duplicate matching

A row counts as a duplicate when every column matches a row already held for
that agency and dataset. Column order is ignored and blank cells don't count, so
an agency reordering its export or adding an empty column won't resurrect old
rows.

Some portals stamp each export with the moment it was generated. That column
would otherwise make every row look new on every pull, so a short list of such
names is left out of the comparison editable under **Duplicate matching** on
the library page. Matching ignores case, spaces, underscores and hyphens, so
`Generated At` and `generated_at` are the same column.

Keep that list short. Leaving a real data column out means two rows that differ
only in that column collapse into one. If re-pulling a portal you have already
collected reports nearly everything as new, that is the symptom: find the column
that changes every time and add it.

### Adding files you already have

Drag CSVs onto the library page, or press **Add CSV files**. Files named
`agency__dataset.csv` the shape this extension writes are filed
automatically. Anything else is filed under its own filename.

## How the collection works

The extension reads the CSV text directly out of the page rather than depending
on Chrome's download folder. It watches every route a site can use to hand over
a file: a blob URL, a data URL, a click dispatched from JavaScript, a plain
`.csv` link, and `fetch`/XHR responses that come back as CSV. That's why a file
still gets captured when the portal saves it under an unpredictable name, or
under the same name as the last nine agencies.

If a file does slip through as a normal Chrome download during a run, it gets
filed into `Downloads/Flock` with the agency name prefixed.

## Settings

- **Save each file separately** — keep every portal's raw CSV alongside the merged one. Worth leaving on for an audit trail.
- **Merge into one file per dataset** — run the merge automatically when the list finishes. You can also trigger it any time with **Save merged CSV**.
- **Wait per portal** — how long before a portal is retried, then given up on. The clock pauses during a security check. Default 6 minutes.
- **Pause between portals** — spacing between agencies. Default 4 seconds; raise it if you start seeing more checks.

## If something goes wrong

**"No download control found"** — the portal's layout differs from the others, or
it didn't finish loading. Open it by hand and check there's a Download CSV
button. Raise **Wait per portal** and retry that URL alone.

**"Clicked, but no CSV came back"** — the button fired but nothing arrived within
30 seconds. Usually a slow server-side export. Retry that portal on its own.

**Checks on every portal** — turn off any VPN, and raise the pause between
portals. Residential connections get challenged far less than datacenter ones.

**The run stalls with the tab closed** — closing the working tab stops the run by
design. Whatever was already collected is kept; press **New run** and start again
with the remaining URLs.

**Nothing responds after a run** — press **New run**. If the popup is still stuck,
reload the extension at `chrome://extensions` (the circular arrow); state is in
storage, so nothing collected is lost.

## Scope

The extension only runs on `transparency.flocksafety.com`. It reads pages you
visit during a run, writes CSVs to your Downloads folder, and keeps captured
text in local extension storage until you clear it. Nothing is sent anywhere.

These portals are published for public accountability. If you need data the
portals don't expose, or want it in a more complete form, a public records
request to each agency is the parallel track worth running.

## License and credit

**FlockOff CSV Grabber**

This work is not subject to copyright protection in the United States and is released into the
public domain. No copyright is claimed. Any rights that might exist in other
countries are waived worldwide under the Creative Commons CC0 1.0 Universal
Public Domain Dedication (`SPDX-License-Identifier: CC0-1.0`).

Use it, change it, fork it, ship it, sell it — no permission needed, no fee, no
notice required. It comes with no warranty of any kind.

The extension bundles no third-party code, fonts, or images, so there are no
other licenses to reconcile. Full terms are in the `LICENSE` file.
