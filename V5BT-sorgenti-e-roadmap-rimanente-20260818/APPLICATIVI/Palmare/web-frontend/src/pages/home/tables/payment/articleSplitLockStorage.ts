import { readLocalPreference, writeLocalPreference } from "../../../../shared/storage/preferenceStorage";

const ARTICLE_SPLIT_LOCK_PREFIX = "mobile_payment_article_split_lock_v1";

export const articleSplitLockKey = (tableId: string, orderId?: string) =>
  `${ARTICLE_SPLIT_LOCK_PREFIX}:${tableId}:${orderId || "table"}`;

export const readArticleSplitLock = (tableId: string, orderId?: string) =>
  readLocalPreference(articleSplitLockKey(tableId, orderId)) === "1";

export const writeArticleSplitLock = (tableId: string, orderId?: string) => {
  writeLocalPreference(articleSplitLockKey(tableId, orderId), "1");
};
