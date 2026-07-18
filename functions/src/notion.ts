import { APIErrorCode, Client, isFullPage, isNotionClientError } from "@notionhq/client";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import { createHmac, timingSafeEqual } from "node:crypto";

export const makeNotionClient = (token: string): Client =>
  new Client({ auth: token, notionVersion: "2025-09-03" });

/** Notion IDs appear both dashed and undashed — compare in canonical form. */
export const normalizeNotionId = (id: string): string =>
  id.replace(/-/g, "").toLowerCase();

/**
 * Verifies X-Notion-Signature: an HMAC-SHA256 of the raw body keyed with the
 * webhook's verification token, sent as "sha256=<hex>".
 */
export const verifyNotionSignature = (
  rawBody: Buffer,
  signatureHeader: string | undefined,
  verificationToken: string,
): boolean => {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody)
    .digest("hex")}`;
  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  return (
    received.length === computed.length && timingSafeEqual(received, computed)
  );
};

/** Fetches the latest version of a page; null if it no longer exists. */
export const retrievePage = async (
  notion: Client,
  pageId: string,
): Promise<PageObjectResponse | null> => {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    return isFullPage(page) ? page : null;
  } catch (error) {
    if (
      isNotionClientError(error) &&
      (error.code === APIErrorCode.ObjectNotFound ||
        error.code === APIErrorCode.ValidationError)
    ) {
      return null;
    }
    throw error;
  }
};

/** Queries every page currently in the data source (paginated). */
export const listAllDataSourcePages = async (
  notion: Client,
  dataSourceId: string,
): Promise<PageObjectResponse[]> => {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const result of response.results) {
      if (isFullPage(result)) pages.push(result);
    }
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return pages;
};
