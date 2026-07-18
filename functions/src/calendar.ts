import { calendar_v3, google } from "googleapis";

import { OrganizerShift, ShiftSyncConfig } from "./types";

export const makeCalendarClient = (
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): calendar_v3.Calendar => {
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: "v3", auth });
};

/**
 * Calendar event IDs must be base32hex ([a-v0-9]); a Notion page ID is a hex
 * UUID, so stripping dashes yields a valid, stable ID. Deriving it this way
 * makes webhook retries and reconciles idempotent with no mapping table —
 * and it's the same derivation used for the Firestore doc ID.
 */
export const eventIdForPage = (pageId: string): string =>
  pageId.replace(/-/g, "").toLowerCase();

const statusOf = (error: unknown): number | undefined =>
  (error as { code?: number; response?: { status?: number } })?.code ??
  (error as { response?: { status?: number } })?.response?.status;

const buildEvent = (
  shift: OrganizerShift,
  config: ShiftSyncConfig,
): calendar_v3.Schema$Event => {
  const attendees = [
    ...new Set([...shift.organizerEmails, ...shift.leadOrganizerEmails]),
  ].map((email) => ({ email }));
  const descriptionParts = [
    shift.description,
    `Notion is the source of truth for this shift — edits made here will be overwritten.${shift.notionUrl ? `\n${shift.notionUrl}` : ""}`,
  ].filter(Boolean);
  return {
    summary: shift.title,
    ...(shift.location ? { location: shift.location } : {}),
    description: descriptionParts.join("\n\n"),
    start: {
      dateTime: shift.startTime.toDate().toISOString(),
      timeZone: config.timezone,
    },
    end: {
      dateTime: shift.endTime.toDate().toISOString(),
      timeZone: config.timezone,
    },
    attendees,
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    status: "confirmed",
    reminders: { useDefault: true },
  };
};

/**
 * Creates or updates the shift's event. Update-if-exists (including cancelled
 * events) rather than insert-then-409: re-confirming a cancelled event is how
 * a deleted-then-restored Notion page gets its invite back, since Calendar
 * remembers cancelled event IDs forever.
 */
export const upsertShiftEvent = async (
  calendar: calendar_v3.Calendar,
  config: ShiftSyncConfig,
  shift: OrganizerShift,
): Promise<void> => {
  const eventId = eventIdForPage(shift.notionPageId);
  const requestBody = buildEvent(shift, config);
  let exists = false;
  try {
    await calendar.events.get({ calendarId: config.calendarId, eventId });
    exists = true;
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
  }
  if (exists) {
    await calendar.events.update({
      calendarId: config.calendarId,
      eventId,
      requestBody,
      sendUpdates: "all",
    });
  } else {
    await calendar.events.insert({
      calendarId: config.calendarId,
      requestBody: { ...requestBody, id: eventId },
      sendUpdates: "all",
    });
  }
};

/** Cancels the shift's event; already-gone (404/410) is success. */
export const deleteShiftEvent = async (
  calendar: calendar_v3.Calendar,
  config: ShiftSyncConfig,
  pageId: string,
): Promise<void> => {
  try {
    await calendar.events.delete({
      calendarId: config.calendarId,
      eventId: eventIdForPage(pageId),
      sendUpdates: "all",
    });
  } catch (error) {
    const status = statusOf(error);
    if (status !== 404 && status !== 410) throw error;
  }
};
