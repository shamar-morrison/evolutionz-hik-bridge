import {
  DEFAULT_PLACEHOLDER_SLOT_PATTERN,
  DEFAULT_RESET_SLOT_END_TIME,
  DEFAULT_USER_MODIFY_MODE,
} from './constants.js';

export function getPlaceholderSlotPattern() {
  const rawPattern = process.env.HIK_PLACEHOLDER_SLOT_PATTERN?.trim();

  if (!rawPattern) {
    return new RegExp(DEFAULT_PLACEHOLDER_SLOT_PATTERN);
  }

  try {
    return new RegExp(rawPattern);
  } catch {
    console.warn(
      `[hik] Invalid HIK_PLACEHOLDER_SLOT_PATTERN="${rawPattern}". Falling back to ${DEFAULT_PLACEHOLDER_SLOT_PATTERN}.`
    );
    return new RegExp(DEFAULT_PLACEHOLDER_SLOT_PATTERN);
  }
}

export function matchesPlaceholderPattern(placeholderPattern, value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }

  placeholderPattern.lastIndex = 0;
  return placeholderPattern.test(value);
}

export function getResetSlotEndTime() {
  return process.env.HIK_RESET_SLOT_END_TIME?.trim() || DEFAULT_RESET_SLOT_END_TIME;
}

export function getUserModifyMode() {
  const configuredMode = process.env.HIK_USER_MODIFY_MODE?.trim();
  const supportedModes = new Set(['full_access', 'valid_only', 'minimal']);

  if (!configuredMode) {
    return DEFAULT_USER_MODIFY_MODE;
  }

  if (supportedModes.has(configuredMode)) {
    return configuredMode;
  }

  console.warn(
    `[hik] Invalid HIK_USER_MODIFY_MODE="${configuredMode}". Falling back to ${DEFAULT_USER_MODIFY_MODE}.`
  );

  return DEFAULT_USER_MODIFY_MODE;
}

export function isAvailableSlotsDebugEnabled() {
  return process.env.HIK_DEBUG_AVAILABLE_SLOTS === '1';
}

export function parseCommaSeparatedEnv(value) {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizePlaceholderNameForDebug(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toUpperCase();
}

export function getAvailableSlotsDebugConfig() {
  const focusedPlaceholderNames = parseCommaSeparatedEnv(
    process.env.HIK_DEBUG_AVAILABLE_SLOTS_PLACEHOLDER_NAMES
  );
  const focusedCardNos = parseCommaSeparatedEnv(
    process.env.HIK_DEBUG_AVAILABLE_SLOTS_CARD_NOS
  );

  return {
    enabled: isAvailableSlotsDebugEnabled(),
    focusedPlaceholderNames,
    focusedCardNos,
    focusedPlaceholderNameSet: new Set(
      focusedPlaceholderNames.map((value) => normalizePlaceholderNameForDebug(value))
    ),
    focusedCardNoSet: new Set(focusedCardNos),
  };
}
