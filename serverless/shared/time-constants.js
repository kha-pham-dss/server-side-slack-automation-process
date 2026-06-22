/**
 * Hằng số thời gian dùng chung (VNT = GMT+7).
 * Lịch EventBridge trong iac/template.yaml quy đổi sang UTC cron — giữ khớp với *_HOUR_GMT7 / *_MINUTE_GMT7 bên dưới.
 */

export const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000;

/** TTL cache config / token SSM (ms). */
export const CACHE_TTL_MS = 60_000;

/** Mon–Fri 9:30 GMT+7 — EventBridge: cron(30 2 ? * MON-FRI *) */
export const POST_MENU_HOUR_GMT7 = 9;
export const POST_MENU_MINUTE_GMT7 = 30;

/** Mon–Fri 10:20 GMT+7 — EventBridge: cron(20 3 ? * MON-FRI *) */
export const COLLECT_ORDERS_HOUR_GMT7 = 10;
export const COLLECT_ORDERS_MINUTE_GMT7 = 20;

/** Mon–Fri 10:45 GMT+7 — EventBridge: cron(45 3 ? * MON-FRI *) */
export const ZALO_SUMMARY_HOUR_GMT7 = 10;
export const ZALO_SUMMARY_MINUTE_GMT7 = 45;

/** Ngưỡng "sau Zalo summary" (slack-events ping reconcile). */
export const ZALO_SUMMARY_CUTOFF_HOUR_GMT7 = ZALO_SUMMARY_HOUR_GMT7;
export const ZALO_SUMMARY_CUTOFF_MINUTE_GMT7 = ZALO_SUMMARY_MINUTE_GMT7;

/** Slack request signature: timestamp lệch tối đa (giây). */
export const SLACK_SIGNATURE_MAX_AGE_SEC = 5 * 60;

/** Delay giữa các reaction emoji khi post menu (ms). */
export const POST_MENU_REACTION_DELAY_MS = 1_000;

export function nowGmt7(now = new Date()) {
  return new Date(now.getTime() + GMT7_OFFSET_MS);
}

/** Khóa ngày DynamoDB (GMT+7 YYYY-MM-DD), cùng post-menu / collect-orders. */
export function dateKeyGmt7(now = new Date()) {
  const gmt7 = nowGmt7(now);
  const year = gmt7.getUTCFullYear();
  const month = String(gmt7.getUTCMonth() + 1).padStart(2, '0');
  const day = String(gmt7.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** @param {number} hourGMT7 0–23 @param {number} minuteGMT7 0–59 */
export function isAtOrAfterGmt7Time(hourGMT7, minuteGMT7, now = new Date()) {
  const gmt7 = nowGmt7(now);
  const hour = gmt7.getUTCHours();
  const minute = gmt7.getUTCMinutes();
  return hour > hourGMT7 || (hour === hourGMT7 && minute >= minuteGMT7);
}

export function isAfterZaloSummaryCutoffNow(now = new Date()) {
  return isAtOrAfterGmt7Time(
    ZALO_SUMMARY_CUTOFF_HOUR_GMT7,
    ZALO_SUMMARY_CUTOFF_MINUTE_GMT7,
    now
  );
}
