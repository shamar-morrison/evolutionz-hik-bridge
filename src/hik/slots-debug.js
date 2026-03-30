import {
  AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT,
  SLOT_TOKEN_PREFIX_PATTERN,
  VALIDITY_DROP_REASONS,
} from './constants.js';
import {
  matchesPlaceholderPattern,
  normalizePlaceholderNameForDebug,
} from './config.js';
import { canonicalizeEmployeeNo, toBoolean } from './shared.js';

export function createInvalidValidityDiagnostics() {
  return {
    total: 0,
    missingValid: 0,
    disabled: 0,
    invalidBeginTime: 0,
    futureBeginTime: 0,
    missingEndTime: 0,
    invalidEndTime: 0,
    expiredEndTime: 0,
  };
}

export function analyzeUserValidity(userInfo, now = new Date()) {
  const valid = userInfo?.Valid;
  const hasValidObject = !!valid && typeof valid === 'object';
  const beginTime =
    hasValidObject && typeof valid.beginTime === 'string' ? valid.beginTime.trim() : '';
  const endTime =
    hasValidObject && typeof valid.endTime === 'string' ? valid.endTime.trim() : '';
  const beginTimestamp = beginTime ? Date.parse(beginTime) : null;
  const endTimestamp = endTime ? Date.parse(endTime) : null;
  const normalizedValidity = {
    hasValidObject,
    enableRaw: hasValidObject ? valid.enable ?? null : null,
    enable: hasValidObject ? toBoolean(valid.enable, false) : false,
    beginTime,
    beginTimestamp: Number.isNaN(beginTimestamp) ? null : beginTimestamp,
    endTime,
    endTimestamp: Number.isNaN(endTimestamp) ? null : endTimestamp,
    nowTimestamp: now.getTime(),
  };

  if (!hasValidObject) {
    return {
      isValid: false,
      reason: 'missingValid',
      rawValid: valid ?? null,
      normalizedValidity,
    };
  }

  if (!normalizedValidity.enable) {
    return {
      isValid: false,
      reason: 'disabled',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (beginTime) {
    if (normalizedValidity.beginTimestamp === null) {
      return {
        isValid: false,
        reason: 'invalidBeginTime',
        rawValid: valid,
        normalizedValidity,
      };
    }

    if (normalizedValidity.beginTimestamp > normalizedValidity.nowTimestamp) {
      return {
        isValid: false,
        reason: 'futureBeginTime',
        rawValid: valid,
        normalizedValidity,
      };
    }
  }

  if (!endTime) {
    return {
      isValid: false,
      reason: 'missingEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (normalizedValidity.endTimestamp === null) {
    return {
      isValid: false,
      reason: 'invalidEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  if (normalizedValidity.endTimestamp < normalizedValidity.nowTimestamp) {
    return {
      isValid: false,
      reason: 'expiredEndTime',
      rawValid: valid,
      normalizedValidity,
    };
  }

  return {
    isValid: true,
    reason: null,
    rawValid: valid,
    normalizedValidity,
  };
}

export function recordInvalidValidity(invalidValidityDiagnostics, reason) {
  invalidValidityDiagnostics.total += 1;

  if (VALIDITY_DROP_REASONS.includes(reason)) {
    invalidValidityDiagnostics[reason] += 1;
  }
}

export function createCardBackedNonSlotDiagnostics() {
  return {
    total: 0,
    missingUserRecord: 0,
    missingPlaceholderName: 0,
    occupiedSlotName: 0,
    otherNonPlaceholderName: 0,
    invalidValidity: createInvalidValidityDiagnostics(),
  };
}

export function extractNameCandidates(record) {
  const nameCandidates = {};

  if (!record || typeof record !== 'object') {
    return nameCandidates;
  }

  for (const [key, value] of Object.entries(record)) {
    if (!key.toLowerCase().includes('name') || typeof value !== 'string') {
      continue;
    }

    const trimmedValue = value.trim();

    if (!trimmedValue) {
      continue;
    }

    nameCandidates[key] = trimmedValue;
  }

  return nameCandidates;
}

export function collectMatchingPlaceholderNames(nameCandidates, placeholderPattern) {
  const matchingPlaceholderNames = [];
  const seenValues = new Set();

  for (const [key, value] of Object.entries(nameCandidates)) {
    if (!matchesPlaceholderPattern(placeholderPattern, value) || seenValues.has(value)) {
      continue;
    }

    seenValues.add(value);
    matchingPlaceholderNames.push({
      key,
      value,
    });
  }

  return matchingPlaceholderNames;
}

export function extractSlotToken(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  const match = trimmedValue.match(SLOT_TOKEN_PREFIX_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

export function collectSlotTokenCandidates(nameCandidates) {
  const slotTokenCandidates = [];
  const seenCandidates = new Set();

  for (const [key, value] of Object.entries(nameCandidates)) {
    const slotToken = extractSlotToken(value);

    if (!slotToken) {
      continue;
    }

    const candidateKey = `${key}\u0000${slotToken}\u0000${value}`;

    if (seenCandidates.has(candidateKey)) {
      continue;
    }

    seenCandidates.add(candidateKey);
    slotTokenCandidates.push({
      key,
      value,
      slotToken,
      exactMatch: value === slotToken,
    });
  }

  return slotTokenCandidates;
}

export function hasFocusedPlaceholderMatch(debugConfig, values = []) {
  if (!debugConfig.focusedPlaceholderNameSet.size) {
    return false;
  }

  return values.some((value) =>
    debugConfig.focusedPlaceholderNameSet.has(normalizePlaceholderNameForDebug(value))
  );
}

export function isFocusedCardNoMatch(debugConfig, cardNo) {
  return !!cardNo && debugConfig.focusedCardNoSet.has(cardNo);
}

export function collectFocusedPlaceholderValues({
  extractedName,
  placeholderNameHint,
  slotToken,
  nameCandidates,
  matchingPlaceholderNames,
  slotTokenCandidates,
}) {
  return [
    extractedName,
    placeholderNameHint,
    slotToken,
    ...Object.values(nameCandidates ?? {}),
    ...(matchingPlaceholderNames ?? []).map((entry) => entry.value),
    ...(slotTokenCandidates ?? []).map((entry) => entry.slotToken),
  ].filter(Boolean);
}

export function createUserDebugRecord(userInfo, placeholderPattern, now) {
  const employeeNo = typeof userInfo?.employeeNo === 'string' ? userInfo.employeeNo.trim() : '';
  const canonicalEmployeeNo = canonicalizeEmployeeNo(employeeNo);
  const extractedName = typeof userInfo?.name === 'string' ? userInfo.name.trim() : '';
  const nameCandidates = extractNameCandidates(userInfo);
  const matchingPlaceholderNames = collectMatchingPlaceholderNames(
    nameCandidates,
    placeholderPattern
  );
  const slotTokenCandidates = collectSlotTokenCandidates(nameCandidates);
  const slotToken = extractSlotToken(extractedName);
  const hasExactPlaceholderName = matchesPlaceholderPattern(placeholderPattern, extractedName);
  const hasOccupiedSlotName = !!slotToken && extractedName !== slotToken;
  const placeholderNameHint =
    matchingPlaceholderNames[0]?.value ??
    (hasExactPlaceholderName ? extractedName : null);

  let classification = 'validPlaceholder';
  let validityEvaluated = false;
  let isCurrentlyValid = null;
  let validityReason = null;
  let normalizedValidity = null;

  if (!employeeNo) {
    classification = 'missingEmployeeNo';
  } else if (!extractedName) {
    classification = 'missingPlaceholderName';
  } else if (!hasExactPlaceholderName) {
    classification = hasOccupiedSlotName ? 'occupiedSlotName' : 'otherNonPlaceholderName';
  } else {
    const validity = analyzeUserValidity(userInfo, now);

    validityEvaluated = true;
    isCurrentlyValid = validity.isValid;
    validityReason = validity.reason;
    normalizedValidity = validity.normalizedValidity;
    classification = validity.isValid ? 'validPlaceholder' : 'invalidValidity';
  }

  return {
    employeeNo,
    canonicalEmployeeNo,
    extractedName,
    placeholderNameHint,
    slotToken,
    nameCandidates,
    matchingPlaceholderNames,
    slotTokenCandidates,
    classification,
    validityEvaluated,
    isCurrentlyValid,
    validityReason,
    normalizedValidity,
    rawUserInfo: userInfo ?? null,
  };
}

export function createCardDebugRecord(cardInfo) {
  const employeeNo = typeof cardInfo?.employeeNo === 'string' ? cardInfo.employeeNo.trim() : '';
  const cardNo = typeof cardInfo?.cardNo === 'string' ? cardInfo.cardNo.trim() : '';

  return {
    employeeNo,
    canonicalEmployeeNo: canonicalizeEmployeeNo(employeeNo),
    cardNo,
    rawCardInfo: cardInfo ?? null,
  };
}

export function isFocusedDirectProbeEnabled(debugConfig) {
  return debugConfig.enabled && debugConfig.focusedCardNos.length > 0;
}

export function getFocusedPlaceholderMatches(debugConfig, values = []) {
  if (!debugConfig.focusedPlaceholderNameSet.size) {
    return [];
  }

  const matches = [];
  const seenMatches = new Set();

  for (const value of values) {
    if (typeof value !== 'string' || !value) {
      continue;
    }

    const normalizedValue = normalizePlaceholderNameForDebug(value);

    if (
      !normalizedValue ||
      !debugConfig.focusedPlaceholderNameSet.has(normalizedValue) ||
      seenMatches.has(normalizedValue)
    ) {
      continue;
    }

    seenMatches.add(normalizedValue);
    matches.push(normalizedValue);
  }

  return matches;
}

export function collectFocusedExactPlaceholderNames(debugConfig, userDebugRecord) {
  return getFocusedPlaceholderMatches(
    debugConfig,
    (userDebugRecord?.matchingPlaceholderNames ?? []).map((entry) => entry.value)
  );
}

export function collectFocusedSlotTokenPrefixes(debugConfig, userDebugRecord) {
  return getFocusedPlaceholderMatches(
    debugConfig,
    (userDebugRecord?.slotTokenCandidates ?? [])
      .filter((entry) => !entry.exactMatch)
      .map((entry) => entry.slotToken)
  );
}

export function buildUserDebugRecordKey(userDebugRecord) {
  return (
    userDebugRecord?.slotToken ??
    userDebugRecord?.placeholderNameHint ??
    userDebugRecord?.extractedName ??
    userDebugRecord?.employeeNo ??
    null
  );
}

export function buildCardDebugRecordKey(cardDebugRecord) {
  return cardDebugRecord?.cardNo ?? cardDebugRecord?.employeeNo ?? null;
}

export function createCompactCardSnippet(cardInfo) {
  if (!cardInfo || typeof cardInfo !== 'object') {
    return null;
  }

  const cardNo = typeof cardInfo.cardNo === 'string' ? cardInfo.cardNo.trim() : null;
  const employeeNo =
    typeof cardInfo.employeeNo === 'string' ? cardInfo.employeeNo.trim() : null;
  const cardType = typeof cardInfo.cardType === 'string' ? cardInfo.cardType.trim() : null;

  return {
    employeeNo,
    cardNo,
    cardType,
  };
}

export function createCompactUserSnippet(userInfo) {
  if (!userInfo || typeof userInfo !== 'object') {
    return null;
  }

  const employeeNo =
    typeof userInfo.employeeNo === 'string' ? userInfo.employeeNo.trim() : null;
  const name = typeof userInfo.name === 'string' ? userInfo.name.trim() : null;

  return {
    employeeNo,
    name,
    Valid:
      userInfo.Valid && typeof userInfo.Valid === 'object'
        ? {
            enable: userInfo.Valid.enable ?? null,
            beginTime: userInfo.Valid.beginTime ?? null,
            endTime: userInfo.Valid.endTime ?? null,
          }
        : null,
  };
}

export function buildDebugReport({
  focusedPlaceholderNames,
  focusedCardNos,
  records,
}) {
  const selectedRecords = [];
  let sampledNonForcedCount = 0;
  let omittedCount = 0;

  for (const record of records) {
    const { forceInclude = false, ...serializableRecord } = record;

    if (forceInclude || sampledNonForcedCount < AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT) {
      selectedRecords.push(serializableRecord);

      if (!forceInclude) {
        sampledNonForcedCount += 1;
      }

      continue;
    }

    omittedCount += 1;
  }

  return {
    sampleLimit: AVAILABLE_SLOT_DEBUG_SAMPLE_LIMIT,
    focusedPlaceholderNames,
    focusedCardNos,
    totalRelevantRecords: records.length,
    omittedCount,
    records: selectedRecords,
  };
}

export function logDebugJson(label, value) {
  console.info(`${label}\n${JSON.stringify(value, null, 2)}`);
}
