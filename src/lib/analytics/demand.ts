/**
 * Where the "already on the books" line is drawn.
 *
 * The bulk import is the day every Square and spreadsheet sale that already
 * existed landed in the app at once. It is not a purchase date — those sales
 * predated it — which makes it the closest thing to a snapshot of what was
 * known before the final week began.
 *
 * Anything created after it is genuinely late demand rather than an artefact of
 * when the data arrived, and that distinction is the whole point of the
 * comparison.
 */
export const BASELINE_DAY = '2026-08-11'
