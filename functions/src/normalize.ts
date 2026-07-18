import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { Timestamp } from "firebase-admin/firestore";

import { OrganizerShift } from "./types";

/**
 * Property names in the shift database. All hackathons duplicate the same
 * Notion template, so these are constants — verify them against the template
 * before each event (Setup step in the README). The volunteer multi-select is
 * deliberately never read: volunteers get neither invites nor pings.
 */
export const NOTION_PROPS = {
  title: "Name",
  /** Date property carrying both start and end. */
  time: "Time",
  /** Person property. */
  organizers: "Organizers",
  /** Person property. */
  shiftLeads: "Shift Lead",
  /** Select or rich-text. */
  location: "Location",
  /** Rich-text. */
  description: "Description",
} as const;

type NotionProperty = PageObjectResponse["properties"][string];

const asPlainText = (property: NotionProperty | undefined): string => {
  if (!property) return "";
  switch (property.type) {
    case "title":
      return property.title.map((t) => t.plain_text).join("");
    case "rich_text":
      return property.rich_text.map((t) => t.plain_text).join("");
    case "select":
      return property.select?.name ?? "";
    default:
      return "";
  }
};

const asPersonEmails = (property: NotionProperty | undefined): string[] => {
  if (property?.type !== "people") return [];
  const emails = property.people
    .map((user) =>
      "type" in user && user.type === "person" ? user.person?.email : undefined,
    )
    .filter((email): email is string => Boolean(email))
    .map((email) => email.trim().toLowerCase());
  return [...new Set(emails)];
};

export type NormalizeResult =
  | { ok: true; shift: OrganizerShift }
  | { ok: false; reasons: string[] };

/**
 * Translates a Notion page into the shared OrganizerShift shape, or reports
 * why it isn't an eligible shift yet (incomplete draft rows are common while
 * logistics builds the schedule).
 */
export const normalizePage = (page: PageObjectResponse): NormalizeResult => {
  const reasons: string[] = [];

  const title = asPlainText(page.properties[NOTION_PROPS.title]).trim();
  if (!title) reasons.push("missing title");

  const timeProperty = page.properties[NOTION_PROPS.time];
  const date = timeProperty?.type === "date" ? timeProperty.date : null;
  let start: Date | null = null;
  let end: Date | null = null;
  if (!date?.start || !date.end) {
    reasons.push("missing start or end time");
  } else {
    start = new Date(date.start);
    end = new Date(date.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      reasons.push("unparseable start or end time");
    } else if (end.getTime() <= start.getTime()) {
      reasons.push("end time is not after start time");
    }
  }

  const organizerEmails = asPersonEmails(
    page.properties[NOTION_PROPS.organizers],
  );
  const leadOrganizerEmails = asPersonEmails(
    page.properties[NOTION_PROPS.shiftLeads],
  );
  if (organizerEmails.length + leadOrganizerEmails.length === 0) {
    reasons.push("no assigned organizers");
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const description = asPlainText(
    page.properties[NOTION_PROPS.description],
  ).trim();
  const location = asPlainText(page.properties[NOTION_PROPS.location]).trim();

  return {
    ok: true,
    shift: {
      notionPageId: page.id,
      title,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      notionUrl: page.url,
      startTime: Timestamp.fromDate(start!),
      endTime: Timestamp.fromDate(end!),
      organizerEmails,
      leadOrganizerEmails,
      updatedAt: Timestamp.fromDate(new Date(page.last_edited_time)),
    },
  };
};
