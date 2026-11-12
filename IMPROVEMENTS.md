# RoadWatch improvements — 30 October 2026

The existing Node/Express, Vite, MongoDB and YOLO architecture is preserved.

## Run the project

On Windows, double-click `runall.bat` or run `.\runall.bat` in PowerShell.
It calls the existing `run.py` launcher. It uses `PYTHON_EXECUTABLE` if set,
otherwise the user's Anaconda Python when installed, then the Python launcher.
`python run.py` and `npm run dev` remain supported when Python is on PATH.

Services use ports 3000 (API), 5173 (frontend) and 5001 (inference).
The launcher checks occupied ports and asks you to stop the existing service;
it no longer kills arbitrary applications occupying these ports.
Environment variables take precedence over root `.env`, then `backend/.env`.
Configure your MongoDB URI using `.env.example`; no database credentials changed.

## Behavior improvements

- Report detail actions retain the UUID when the dialog closes.
- The directory loads all API pages instead of silently stopping at 100 reports.
  It renders 20 rows per page, with working previous/next buttons and page counts.
- Search resets pagination, global search opens Reports, and dashboard map search works.
- Nearby searches read the API's `potholes` field. Report filtering preserves the
  complete directory; Reset filters restores it. Zero nearby results clear map markers.
- Loading, error, retry and stale-data messages distinguish missing data from failed requests.
- Compact-table and banner preferences persist in browser storage.
- Dialogs manage focus, isolate background controls and support keyboard navigation.
  Report cards respond to Enter/Space; controls have accessible labels and focus outlines.
- Maps use the installed Leaflet package instead of third-party CDN scripts/styles.
- Maps render without waiting for GPS permission; precise location remains available on demand.
- Leaving detection stops camera streams and polling. Webcam capture reuses one canvas.
- Confidence telemetry averages actual detections. Failed image inference shows an error.
- Zero latitude/longitude is accepted; blank, boolean and non-finite coordinates are rejected.
- Invalid pagination and detection parameters return 400. Malformed JSON preserves its 400 status.
- Disconnected database requests return 503 immediately rather than waiting on query buffering.
- The backend default port matches the proxy, and CLI inference uses the launcher's Python.
- Map popup actions use DOM listeners instead of interpolating report IDs into JavaScript.

## Performance evidence and limits

| Work | Before | After |
| --- | --- | --- |
| Directory rows rendered with 45 reports | 45 | 20, then 20, then 5 |
| Statistics database operations | count + find (2) | projected lean find (1) |
| Two simultaneous refreshes for two API pages | duplicate refresh work | 2 page requests total |
| Startup API requests | serial | concurrent |
| Webcam canvas creation | once per frame | once per session |

The query count and directory/refresh behavior are guarded by regression tests.
No claim of a production latency improvement is made: database size, camera hardware,
model warm-up and network conditions vary. The directory still loads all metadata for
map and dashboard views; a viewport API would be appropriate for very large datasets.
Stats still scans projected metadata once. Map tiles and fonts require internet access.
Bundling Leaflet increases the Vite artifact size because Leaflet was previously loaded
separately from a CDN; this removes the external script dependency.

Mongoose's [version 8 lean documentation](https://mongoosejs.com/docs/8.x/docs/tutorials/lean.html)
explains why projected read-only statistics do not need hydrated document instances.

## Verification

- `npm test`: route smoke tests and 17 regression tests.
- `npm run build:frontend`: production asset build.
- Local browser: live MongoDB reports, report dialog, loading/error recovery and maps.
- Full-stack startup using the existing `run.py` with installed Anaconda Python.
- Real YOLO inference on `frontend/public/samples/pothole_1.jpg`: HTTP 200,
  successful inference and one detected pothole. No database records created or deleted.

Camera permissions, physical IP camera feeds and real GPS acquisition require the user's
devices and were not exercised. Status writes and deletions were checked with isolated
test doubles to preserve existing reports. This was an improvement pass, not a full
production authentication/deployment audit. Original edited-file snapshots are kept in
`.roadwatch-backup/20261030/` (excluded from Git).

## Actual report photos

Manual reports now save the selected photo in `data.photo`, and detection registrations
attach the successful inference frame captured before GPS lookup. Create Detailed Report
carries that frame into the form. Attachments can be previewed, removed or cleared by Reset.
Directory/recent cards and report details display the real saved photo; older reports use
a neutral No photo placeholder. Existing records are not backfilled with sample images.

JPG, PNG and WEBP uploads up to 10 MB are decoded in the browser, resized to a maximum
960-pixel edge and re-encoded as JPEG, removing original camera metadata. The API accepts
only canonical JPEG data URLs with JPEG signatures, up to 1 MB. This is deliberately
stored in the existing MongoDB record for this showcase; large deployments should serve
images separately rather than including base64 photos in directory responses.

Browser verification used a bundled sample to inspect the compressed photo preview.
Save payloads, persistence through the controller, and detection-frame consistency were
checked using isolated test doubles; no existing database reports were changed.

## Visual refresh

RoadWatch blends the original soft interface with the refreshed layout: navy navigation,
cool off-white surfaces, familiar blue actions, rounded cards and subtle shadows.
The map anchors the overview beside a readable evidence list. Typography, form labels, touch targets,
report tables and camera controls are larger and more consistent. Product-facing copy
explains the workflow; database and implementation details remain in diagnostics.

Responsive layouts were inspected in the browser at desktop width and 390 px mobile width.
Mobile navigation includes a dismissible scrim, visible branding and inactive hidden controls.
View transitions respect reduced-motion preferences. No new frontend dependencies were added.

The submit map now starts with no selected damage location and never asks for GPS merely
to display a viewport. A map click selects the report location. Device location remains
an explicit action and shows the browser's reported accuracy; reset clears the pin and
coordinates. Two regression tests cover these location semantics.
