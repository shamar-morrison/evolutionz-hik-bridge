export const DIGEST_RETRY_ATTEMPTS = 2;
export const REMOTE_CONTROL_PASSWORD_PATTERN = /^\d{6}$/;
export const SEARCH_PAGE_SIZE = 30;
export const DEFAULT_PLACEHOLDER_SLOT_PATTERN = '^[A-Z]\\d{1,2}$';
export const DEFAULT_RESET_SLOT_END_TIME = '2037-12-31T23:59:59';
export const AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT = 10;
export const SLOT_TOKEN_PREFIX_PATTERN = /^([A-Z]\d{1,2})(?=\s|$)/i;
export const VALIDITY_DROP_REASONS = [
  'missingValid',
  'disabled',
  'invalidBeginTime',
  'futureBeginTime',
  'missingEndTime',
  'invalidEndTime',
  'expiredEndTime',
];
