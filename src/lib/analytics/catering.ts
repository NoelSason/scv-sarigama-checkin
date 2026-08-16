/**
 * What was actually ordered from the caterer.
 *
 * This is the one number on the whole analytics page that the database cannot
 * know: it was a decision made in a phone call about a week before the event,
 * against the headcount as it stood at the time. It is recorded here so the
 * page can compare the plan against what turned up, which turns out to be the
 * most expensive lesson of the day.
 *
 * Everything it is compared against IS derived — admissions sold, guests
 * accounted for, and when each record entered the system — so the gap can never
 * be flattered by editing this file.
 */

/** Sadhya meals ordered from the caterer, about a week before the event. */
export const MEALS_ORDERED = 270

/**
 * The day the bulk import ran, when every Square and spreadsheet sale that
 * already existed landed in the app at once.
 *
 * It is the closest thing to a snapshot of "what was known when the order went
 * in": those records were all real sales that predated it. Anything created
 * after this date is genuinely late demand, and that distinction is the whole
 * point of the comparison.
 */
export const BASELINE_DAY = '2026-08-11'
