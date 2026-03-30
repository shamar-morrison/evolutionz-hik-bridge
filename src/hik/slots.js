import { SEARCH_PAGE_SIZE } from './constants.js';
import {
  getAvailableSlotsDebugConfig,
  getPlaceholderSlotPattern,
  getResetSlotEndTime,
} from './config.js';
import {
  buildCardDebugRecordKey,
  buildDebugReport,
  buildUserDebugRecordKey,
  collectFocusedExactPlaceholderNames,
  collectFocusedPlaceholderValues,
  collectFocusedSlotTokenPrefixes,
  createCardBackedNonSlotDiagnostics,
  createCardDebugRecord,
  createCompactCardSnippet,
  createCompactUserSnippet,
  createInvalidValidityDiagnostics,
  createUserDebugRecord,
  hasFocusedPlaceholderMatch,
  isFocusedCardNoMatch,
  isFocusedDirectProbeEnabled,
  logDebugJson,
  recordInvalidValidity,
} from './slots-debug.js';
import {
  canonicalizeEmployeeNo,
  formatDatePart,
  getNumericField,
  normalizeSearchMetadata,
  shouldContinuePagedSearch,
} from './shared.js';
import {
  addUser,
  getUserCount,
  normalizeUserInfoList,
  searchUsers,
} from './users.js';
import {
  getCardCount,
  normalizeCardInfoList,
  searchCards,
} from './cards.js';
import { getCapabilities } from './capabilities.js';

function summarizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isUnsupportedFocusedProbeError(errorMessage) {
  if (typeof errorMessage !== 'string') {
    return false;
  }

  const normalized = errorMessage.toLowerCase();

  return normalized.includes('badparameters') || normalized.includes('invalid content');
}

function extractCountValue(rawResponse) {
  const preferredKeys = [
    'userNumber',
    'cardNumber',
    'userCount',
    'cardCount',
    'count',
    'totalCount',
    'total',
    'numOfUsers',
    'numOfCards',
  ];
  const visited = new Set();

  function visit(value, preferMatchingKeys = true) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (/^\d+$/.test(trimmed)) {
        return Number(trimmed);
      }

      return null;
    }

    if (!value || typeof value !== 'object' || visited.has(value)) {
      return null;
    }

    visited.add(value);

    if (preferMatchingKeys) {
      for (const key of preferredKeys) {
        if (key in value) {
          const extracted = visit(value[key], false);

          if (extracted !== null) {
            return extracted;
          }
        }
      }

      for (const [key, nestedValue] of Object.entries(value)) {
        if (!/(count|number|total)/i.test(key)) {
          continue;
        }

        const extracted = visit(nestedValue, false);

        if (extracted !== null) {
          return extracted;
        }
      }
    }

    for (const nestedValue of Object.values(value)) {
      const extracted = visit(nestedValue, true);

      if (extracted !== null) {
        return extracted;
      }
    }

    return null;
  }

  return visit(rawResponse);
}

async function captureDeviceProbe(probeFn, { extractValue = false } = {}) {
  try {
    const rawResponse = await probeFn();

    return {
      status: 'ok',
      value: extractValue ? extractCountValue(rawResponse) : null,
      rawResponse,
      error: null,
    };
  } catch (error) {
    return {
      status: 'error',
      value: null,
      rawResponse: null,
      error: summarizeError(error),
    };
  }
}

async function probeFocusedUsersByEmployeeNo({
  employeeNos,
  maxResults,
  placeholderPattern,
  now,
  probeIndex,
}) {
  const userProbes = [];

  for (const [userProbeIndex, employeeNo] of employeeNos.entries()) {
    const directUserProbeRecord = {
      key: employeeNo,
      employeeNo,
      canonicalEmployeeNo: canonicalizeEmployeeNo(employeeNo),
      request: {
        searchID: `focused-user-probe-${probeIndex + 1}-${userProbeIndex + 1}`,
        searchResultPosition: 0,
        maxResults,
        employeeNoList: [employeeNo],
      },
      status: 'noMatch',
      responseStatusStrg: null,
      numOfMatches: null,
      totalMatches: null,
      returnedNames: [],
      rawUserInfo: [],
      userRecords: [],
      error: null,
    };

    try {
      const directUserResponse = await searchUsers({
        searchID: directUserProbeRecord.request.searchID,
        searchResultPosition: 0,
        maxResults,
        employeeNos: [employeeNo],
      });
      const directUserSearch = directUserResponse?.UserInfoSearch;

      if (!directUserSearch || typeof directUserSearch !== 'object') {
        throw new Error('Device returned an unexpected focused user probe response.');
      }

      const directUserInfoList = normalizeUserInfoList(directUserSearch.UserInfo);
      const directUserMetadata = normalizeSearchMetadata(
        directUserSearch,
        directUserInfoList.length
      );

      directUserProbeRecord.responseStatusStrg = directUserMetadata.responseStatusStrg;
      directUserProbeRecord.numOfMatches = directUserMetadata.numOfMatches;
      directUserProbeRecord.totalMatches = directUserMetadata.totalMatches;
      directUserProbeRecord.returnedNames = Array.from(
        new Set(
          directUserInfoList
            .map((userInfo) =>
              typeof userInfo?.name === 'string' ? userInfo.name.trim() : ''
            )
            .filter(Boolean)
        )
      );
      directUserProbeRecord.rawUserInfo = directUserInfoList;
      directUserProbeRecord.userRecords = directUserInfoList.map((userInfo) =>
        createUserDebugRecord(userInfo, placeholderPattern, now)
      );
      directUserProbeRecord.status =
        directUserProbeRecord.userRecords.length > 0 ? 'found' : 'noMatch';
    } catch (error) {
      directUserProbeRecord.error = summarizeError(error);
      directUserProbeRecord.status = isUnsupportedFocusedProbeError(
        directUserProbeRecord.error
      )
        ? 'unsupported'
        : 'error';
    }

    userProbes.push(directUserProbeRecord);
  }

  return userProbes;
}

async function probeFocusedUserByFuzzySearch({
  query,
  purpose,
  maxResults,
  placeholderPattern,
  now,
  probeIndex,
}) {
  const probeRecord = {
    key: `${purpose}:${query}`,
    query,
    purpose,
    request: {
      searchID: `focused-fuzzy-user-probe-${purpose}-${probeIndex + 1}`,
      searchResultPosition: 0,
      maxResults,
      fuzzySearch: query,
    },
    status: 'noMatch',
    responseStatusStrg: null,
    numOfMatches: null,
    totalMatches: null,
    returnedEmployeeNos: [],
    returnedNames: [],
    rawUserInfo: [],
    userRecords: [],
    error: null,
  };

  try {
    const response = await searchUsers({
      searchID: probeRecord.request.searchID,
      searchResultPosition: 0,
      maxResults,
      fuzzySearch: query,
    });
    const userInfoSearch = response?.UserInfoSearch;

    if (!userInfoSearch || typeof userInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected focused fuzzy user probe response.');
    }

    const userInfoList = normalizeUserInfoList(userInfoSearch.UserInfo);
    const searchMetadata = normalizeSearchMetadata(
      userInfoSearch,
      userInfoList.length
    );

    probeRecord.responseStatusStrg = searchMetadata.responseStatusStrg;
    probeRecord.numOfMatches = searchMetadata.numOfMatches;
    probeRecord.totalMatches = searchMetadata.totalMatches;
    probeRecord.rawUserInfo = userInfoList;
    probeRecord.userRecords = userInfoList.map((userInfo) =>
      createUserDebugRecord(userInfo, placeholderPattern, now)
    );
    probeRecord.returnedEmployeeNos = Array.from(
      new Set(
        probeRecord.userRecords
          .map((record) => record.employeeNo)
          .filter(Boolean)
      )
    );
    probeRecord.returnedNames = Array.from(
      new Set(
        probeRecord.userRecords
          .map((record) => record.extractedName)
          .filter(Boolean)
      )
    );
    probeRecord.status = probeRecord.userRecords.length > 0 ? 'found' : 'noMatch';
  } catch (error) {
    probeRecord.error = summarizeError(error);
    probeRecord.status = isUnsupportedFocusedProbeError(probeRecord.error)
      ? 'unsupported'
      : 'error';
  }

  return probeRecord;
}

async function probeFocusedCard({
  cardNo,
  maxResults,
  placeholderPattern,
  now,
  probeIndex,
}) {
  const probeRecord = {
    key: cardNo,
    cardNo,
    request: {
      searchID: `focused-card-probe-${probeIndex + 1}`,
      searchResultPosition: 0,
      maxResults,
      cardNoList: [cardNo],
    },
    directCardProbeStatus: 'noMatch',
    responseStatusStrg: null,
    numOfMatches: null,
    totalMatches: null,
    returnedEmployeeNos: [],
    rawCardInfo: [],
    userProbes: [],
    error: null,
  };
  const directCardDebugRecords = [];

  try {
    const response = await searchCards({
      searchID: probeRecord.request.searchID,
      searchResultPosition: 0,
      maxResults,
      cardNos: [cardNo],
    });
    const directCardSearch = response?.CardInfoSearch;

    if (!directCardSearch || typeof directCardSearch !== 'object') {
      throw new Error('Device returned an unexpected focused card probe response.');
    }

    const directCardInfoList = normalizeCardInfoList(directCardSearch.CardInfo);
    const directCardMetadata = normalizeSearchMetadata(
      directCardSearch,
      directCardInfoList.length
    );

    probeRecord.responseStatusStrg = directCardMetadata.responseStatusStrg;
    probeRecord.numOfMatches = directCardMetadata.numOfMatches;
    probeRecord.totalMatches = directCardMetadata.totalMatches;
    probeRecord.rawCardInfo = directCardInfoList;

    const directEmployeeNos = [];
    const seenDirectEmployeeNos = new Set();

    for (const cardInfo of directCardInfoList) {
      const directCardDebugRecord = createCardDebugRecord(cardInfo);
      directCardDebugRecords.push(directCardDebugRecord);

      if (
        directCardDebugRecord.employeeNo &&
        !seenDirectEmployeeNos.has(directCardDebugRecord.employeeNo)
      ) {
        seenDirectEmployeeNos.add(directCardDebugRecord.employeeNo);
        directEmployeeNos.push(directCardDebugRecord.employeeNo);
      }
    }

    probeRecord.returnedEmployeeNos = directEmployeeNos;
    probeRecord.directCardProbeStatus =
      directCardDebugRecords.length > 0 ? 'found' : 'noMatch';
    probeRecord.userProbes = await probeFocusedUsersByEmployeeNo({
      employeeNos: directEmployeeNos,
      maxResults,
      placeholderPattern,
      now,
      probeIndex,
    });
  } catch (error) {
    probeRecord.error = summarizeError(error);
    probeRecord.directCardProbeStatus = isUnsupportedFocusedProbeError(probeRecord.error)
      ? 'unsupported'
      : 'error';
  }

  return {
    probeRecord,
    directCardDebugRecords,
  };
}

function dedupeDirectUserRecords(userRecords) {
  const recordsByKey = new Map();

  for (const record of userRecords) {
    const key = [
      record.employeeNo ?? '',
      record.canonicalEmployeeNo ?? '',
      record.extractedName ?? '',
      record.slotToken ?? '',
      record.classification ?? '',
    ].join('\u0000');

    if (!recordsByKey.has(key)) {
      recordsByKey.set(key, record);
    }
  }

  return Array.from(recordsByKey.values());
}

function buildFocusedComparisonClassification({
  bulkHasFocusedEvidence,
  directCardProbeStatus,
  directUserFuzzyHit,
  directUserFuzzyProbeUnsupported,
  directUserFuzzyProbeError,
}) {
  if (bulkHasFocusedEvidence && (directCardProbeStatus === 'found' || directUserFuzzyHit)) {
    return 'foundInBulkAndDirect';
  }

  if (!bulkHasFocusedEvidence && directCardProbeStatus === 'found') {
    return 'foundDirectOnly';
  }

  if (!bulkHasFocusedEvidence && directUserFuzzyHit) {
    return 'bulkMissWithDirectUserFuzzyHit';
  }

  if (bulkHasFocusedEvidence) {
    return 'foundBulkOnly';
  }

  if (
    directCardProbeStatus === 'unsupported' ||
    directUserFuzzyProbeUnsupported
  ) {
    return 'inconclusive';
  }

  if (directCardProbeStatus === 'error' || directUserFuzzyProbeError) {
    return 'bulkMissWithProbeError';
  }

  return 'notFoundAnywhere';
}

export async function listAvailableSlots({ maxResults = SEARCH_PAGE_SIZE, now = new Date() } = {}) {
  const placeholderPattern = getPlaceholderSlotPattern();
  const debugConfig = getAvailableSlotsDebugConfig();
  const availableSlotsDebugEnabled = debugConfig.enabled;
  const focusedDirectProbeEnabled = isFocusedDirectProbeEnabled(debugConfig);
  const userSearchID = `evolutionz-users-${Date.now()}`;
  const cardSearchID = `evolutionz-cards-${Date.now()}`;
  const placeholderUsers = new Map();
  const userDebugRecords = [];
  const userDebugRecordsByJoinEmployeeNo = new Map();
  const cardsByEmployeeNo = new Map();
  const cardDebugRecords = [];
  const cardDebugRecordsByCardNo = new Map();
  const selectedCardRecordsByJoinEmployeeNo = new Map();
  const focusedBulkUserPageTraces = [];
  const focusedBulkCardPageTraces = [];
  const diagnostics = {
    userPages: 0,
    cardPages: 0,
    totalUsersScanned: 0,
    totalCardsScanned: 0,
    matchedPlaceholderUsers: 0,
    matchedJoinedSlots: 0,
    droppedUsers: {
      missingEmployeeNo: 0,
      missingPlaceholderName: 0,
      occupiedSlotName: 0,
      otherNonPlaceholderName: 0,
      invalidValidity: createInvalidValidityDiagnostics(),
    },
    droppedCards: {
      missingEmployeeNo: 0,
      missingCardNo: 0,
    },
    droppedSlots: {
      withoutCard: 0,
    },
    cardBackedNonSlots: createCardBackedNonSlotDiagnostics(),
  };
  let userSearchResultPosition = 0;
  let cardSearchResultPosition = 0;

  while (true) {
    const response = await searchUsers({
      searchID: userSearchID,
      searchResultPosition: userSearchResultPosition,
      maxResults,
    });
    const userInfoSearch = response?.UserInfoSearch;

    if (!userInfoSearch || typeof userInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected user search response.');
    }

    const userInfoList = normalizeUserInfoList(userInfoSearch.UserInfo);
    const userSearchMetadata = normalizeSearchMetadata(
      userInfoSearch,
      userInfoList.length
    );
    const pageUserDebugRecords = [];
    diagnostics.userPages += 1;
    diagnostics.totalUsersScanned += userInfoList.length;

    for (const userInfo of userInfoList) {
      const userDebugRecord = createUserDebugRecord(userInfo, placeholderPattern, now);
      userDebugRecords.push(userDebugRecord);
      pageUserDebugRecords.push(userDebugRecord);

      if (userDebugRecord.canonicalEmployeeNo) {
        userDebugRecordsByJoinEmployeeNo.set(
          userDebugRecord.canonicalEmployeeNo,
          userDebugRecord
        );
      }

      if (userDebugRecord.classification === 'missingEmployeeNo') {
        diagnostics.droppedUsers.missingEmployeeNo += 1;
        continue;
      }

      if (userDebugRecord.classification === 'missingPlaceholderName') {
        diagnostics.droppedUsers.missingPlaceholderName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'occupiedSlotName') {
        diagnostics.droppedUsers.occupiedSlotName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'otherNonPlaceholderName') {
        diagnostics.droppedUsers.otherNonPlaceholderName += 1;
        continue;
      }

      if (userDebugRecord.classification === 'invalidValidity') {
        recordInvalidValidity(
          diagnostics.droppedUsers.invalidValidity,
          userDebugRecord.validityReason
        );
        continue;
      }

      if (!userDebugRecord.canonicalEmployeeNo) {
        diagnostics.droppedUsers.missingEmployeeNo += 1;
        continue;
      }

      placeholderUsers.set(userDebugRecord.canonicalEmployeeNo, {
        employeeNo: userDebugRecord.employeeNo,
        joinEmployeeNo: userDebugRecord.canonicalEmployeeNo,
        placeholderName: userDebugRecord.extractedName,
      });
    }

    if (focusedDirectProbeEnabled) {
      const matchingExactFocusedPlaceholderNames = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedExactPlaceholderNames(debugConfig, record)
          )
        )
      );
      const matchingFocusedSlotTokenPrefixes = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedSlotTokenPrefixes(debugConfig, record)
          )
        )
      );

      focusedBulkUserPageTraces.push({
        searchResultPosition: userSearchResultPosition,
        numOfMatches: userSearchMetadata.numOfMatches,
        totalMatches: userSearchMetadata.totalMatches,
        responseStatusStrg: userSearchMetadata.responseStatusStrg,
        firstResultKey: buildUserDebugRecordKey(pageUserDebugRecords[0]),
        lastResultKey: buildUserDebugRecordKey(
          pageUserDebugRecords[pageUserDebugRecords.length - 1]
        ),
        containsFocusedCardNo: false,
        containsExactFocusedPlaceholderName:
          matchingExactFocusedPlaceholderNames.length > 0,
        containsFocusedSlotTokenPrefix:
          matchingFocusedSlotTokenPrefixes.length > 0,
        matchingFocusedCardNos: [],
        matchingExactFocusedPlaceholderNames,
        matchingFocusedSlotTokenPrefixes,
      });
    }

    const totalMatches = getNumericField(
      userSearchMetadata.totalMatches,
      userSearchResultPosition + userSearchMetadata.numOfMatches
    );

    if (!shouldContinuePagedSearch({
      responseStatus: userSearchMetadata.responseStatusStrg,
      searchResultPosition: userSearchResultPosition,
      matchesOnPage: userSearchMetadata.numOfMatches,
      totalMatches,
    })) {
      break;
    }

    userSearchResultPosition += userSearchMetadata.numOfMatches;
  }

  diagnostics.matchedPlaceholderUsers = placeholderUsers.size;

  while (true) {
    const response = await searchCards({
      searchID: cardSearchID,
      searchResultPosition: cardSearchResultPosition,
      maxResults,
    });
    const cardInfoSearch = response?.CardInfoSearch;

    if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected card search response.');
    }

    const cardInfoList = normalizeCardInfoList(cardInfoSearch.CardInfo);
    const cardSearchMetadata = normalizeSearchMetadata(
      cardInfoSearch,
      cardInfoList.length
    );
    const pageCardDebugRecords = [];
    diagnostics.cardPages += 1;
    diagnostics.totalCardsScanned += cardInfoList.length;

    for (const cardInfo of cardInfoList) {
      const cardDebugRecord = createCardDebugRecord(cardInfo);
      cardDebugRecords.push(cardDebugRecord);
      pageCardDebugRecords.push(cardDebugRecord);

      if (cardDebugRecord.cardNo) {
        cardDebugRecordsByCardNo.set(cardDebugRecord.cardNo, cardDebugRecord);
      }

      if (!cardDebugRecord.employeeNo || !cardDebugRecord.cardNo) {
        if (!cardDebugRecord.employeeNo) {
          diagnostics.droppedCards.missingEmployeeNo += 1;
        }

        if (!cardDebugRecord.cardNo) {
          diagnostics.droppedCards.missingCardNo += 1;
        }

        continue;
      }

      if (!cardDebugRecord.canonicalEmployeeNo) {
        diagnostics.droppedCards.missingEmployeeNo += 1;
        continue;
      }

      const existingCardNo = cardsByEmployeeNo.get(cardDebugRecord.canonicalEmployeeNo);

      if (
        !existingCardNo ||
        cardDebugRecord.cardNo.localeCompare(existingCardNo) < 0
      ) {
        cardsByEmployeeNo.set(
          cardDebugRecord.canonicalEmployeeNo,
          cardDebugRecord.cardNo
        );
        selectedCardRecordsByJoinEmployeeNo.set(
          cardDebugRecord.canonicalEmployeeNo,
          cardDebugRecord
        );
      }
    }

    if (focusedDirectProbeEnabled) {
      const pageUserDebugRecords = pageCardDebugRecords
        .map((record) =>
          record.canonicalEmployeeNo
            ? userDebugRecordsByJoinEmployeeNo.get(record.canonicalEmployeeNo) ?? null
            : null
        )
        .filter(Boolean);
      const matchingFocusedCardNos = pageCardDebugRecords
        .filter((record) => isFocusedCardNoMatch(debugConfig, record.cardNo))
        .map((record) => record.cardNo);
      const matchingExactFocusedPlaceholderNames = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedExactPlaceholderNames(debugConfig, record)
          )
        )
      );
      const matchingFocusedSlotTokenPrefixes = Array.from(
        new Set(
          pageUserDebugRecords.flatMap((record) =>
            collectFocusedSlotTokenPrefixes(debugConfig, record)
          )
        )
      );

      focusedBulkCardPageTraces.push({
        searchResultPosition: cardSearchResultPosition,
        numOfMatches: cardSearchMetadata.numOfMatches,
        totalMatches: cardSearchMetadata.totalMatches,
        responseStatusStrg: cardSearchMetadata.responseStatusStrg,
        firstResultKey: buildCardDebugRecordKey(pageCardDebugRecords[0]),
        lastResultKey: buildCardDebugRecordKey(
          pageCardDebugRecords[pageCardDebugRecords.length - 1]
        ),
        containsFocusedCardNo: matchingFocusedCardNos.length > 0,
        containsExactFocusedPlaceholderName:
          matchingExactFocusedPlaceholderNames.length > 0,
        containsFocusedSlotTokenPrefix:
          matchingFocusedSlotTokenPrefixes.length > 0,
        matchingFocusedCardNos,
        matchingExactFocusedPlaceholderNames,
        matchingFocusedSlotTokenPrefixes,
      });
    }

    const totalMatches = getNumericField(
      cardSearchMetadata.totalMatches,
      cardSearchResultPosition + cardSearchMetadata.numOfMatches
    );

    if (!shouldContinuePagedSearch({
      responseStatus: cardSearchMetadata.responseStatusStrg,
      searchResultPosition: cardSearchResultPosition,
      matchesOnPage: cardSearchMetadata.numOfMatches,
      totalMatches,
    })) {
      break;
    }

    cardSearchResultPosition += cardSearchMetadata.numOfMatches;
  }

  const slots = Array.from(placeholderUsers.values())
    .map((user) => {
      const cardNo = cardsByEmployeeNo.get(user.joinEmployeeNo);

      if (!cardNo) {
        diagnostics.droppedSlots.withoutCard += 1;
        return null;
      }

      return {
        employeeNo: user.employeeNo,
        cardNo,
        placeholderName: user.placeholderName,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.placeholderName.localeCompare(right.placeholderName) ||
      left.cardNo.localeCompare(right.cardNo)
    );

  diagnostics.matchedJoinedSlots = slots.length;

  const cardBackedNonSlotRecords = [];

  for (const [joinEmployeeNo, cardNo] of Array.from(cardsByEmployeeNo.entries()).sort(
    (left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0])
  )) {
    if (placeholderUsers.has(joinEmployeeNo)) {
      continue;
    }

    diagnostics.cardBackedNonSlots.total += 1;

    const cardDebugRecord = selectedCardRecordsByJoinEmployeeNo.get(joinEmployeeNo) ?? null;
    const userDebugRecord = userDebugRecordsByJoinEmployeeNo.get(joinEmployeeNo) ?? null;
    const placeholderNameValues = userDebugRecord
      ? collectFocusedPlaceholderValues(userDebugRecord)
      : [];
    const forceInclude =
      hasFocusedPlaceholderMatch(debugConfig, placeholderNameValues) ||
      isFocusedCardNoMatch(debugConfig, cardNo);
    const debugMatchedBy = [];

    if (hasFocusedPlaceholderMatch(debugConfig, placeholderNameValues)) {
      debugMatchedBy.push('focusedPlaceholderName');
    }

    if (isFocusedCardNoMatch(debugConfig, cardNo)) {
      debugMatchedBy.push('focusedCardNo');
    }

    let userClassification = 'missingUserRecord';

    if (!userDebugRecord) {
      diagnostics.cardBackedNonSlots.missingUserRecord += 1;
    } else {
      userClassification = userDebugRecord.classification;

      if (userClassification === 'missingPlaceholderName') {
        diagnostics.cardBackedNonSlots.missingPlaceholderName += 1;
      } else if (userClassification === 'occupiedSlotName') {
        diagnostics.cardBackedNonSlots.occupiedSlotName += 1;
      } else if (userClassification === 'otherNonPlaceholderName') {
        diagnostics.cardBackedNonSlots.otherNonPlaceholderName += 1;
      } else if (userClassification === 'invalidValidity') {
        recordInvalidValidity(
          diagnostics.cardBackedNonSlots.invalidValidity,
          userDebugRecord.validityReason
        );
      }
    }

    cardBackedNonSlotRecords.push({
      key:
        userDebugRecord?.slotToken || userDebugRecord?.placeholderNameHint
          ? `${cardNo} • ${userDebugRecord?.slotToken ?? userDebugRecord?.placeholderNameHint}`
          : cardNo,
      cardNo,
      employeeNo: cardDebugRecord?.employeeNo ?? userDebugRecord?.employeeNo ?? null,
      canonicalEmployeeNo: joinEmployeeNo,
      placeholderNameHint: userDebugRecord?.placeholderNameHint ?? null,
      slotToken: userDebugRecord?.slotToken ?? null,
      extractedName: userDebugRecord?.extractedName ?? null,
      nameCandidates: userDebugRecord?.nameCandidates ?? {},
      matchingPlaceholderNames: userDebugRecord?.matchingPlaceholderNames ?? [],
      slotTokenCandidates: userDebugRecord?.slotTokenCandidates ?? [],
      userRecordFound: !!userDebugRecord,
      userClassification,
      validityEvaluated: userDebugRecord?.validityEvaluated ?? false,
      isCurrentlyValid: userDebugRecord?.isCurrentlyValid ?? null,
      validityReason: userDebugRecord?.validityReason ?? null,
      normalizedValidity: userDebugRecord?.normalizedValidity ?? null,
      debugMatchedBy,
      rawCardInfo: cardDebugRecord?.rawCardInfo ?? null,
      rawUserInfo: userDebugRecord?.rawUserInfo ?? null,
      forceInclude,
    });
  }

  const focusedBulkUserRecords = userDebugRecords.filter((record) => {
    const exactMatches = collectFocusedExactPlaceholderNames(debugConfig, record);
    const prefixMatches = collectFocusedSlotTokenPrefixes(debugConfig, record);

    return exactMatches.length > 0 || prefixMatches.length > 0;
  });
  const focusedDirectCardProbes = [];
  const focusedDirectUserFuzzyProbes = [];
  const focusedComparisonRecords = [];
  let focusedDeviceEvidence = null;

  if (focusedDirectProbeEnabled) {
    const [capabilitiesProbe, userCountProbe, cardCountProbe] = await Promise.all([
      captureDeviceProbe(() => getCapabilities()),
      captureDeviceProbe(() => getUserCount(), { extractValue: true }),
      captureDeviceProbe(() => getCardCount(), { extractValue: true }),
    ]);

    focusedDeviceEvidence = {
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      bulkTotals: {
        userPages: diagnostics.userPages,
        cardPages: diagnostics.cardPages,
        totalUsersScanned: diagnostics.totalUsersScanned,
        totalCardsScanned: diagnostics.totalCardsScanned,
      },
      bulkCoverage: {
        lastUserResultKey:
          focusedBulkUserPageTraces[focusedBulkUserPageTraces.length - 1]?.lastResultKey ??
          buildUserDebugRecordKey(userDebugRecords[userDebugRecords.length - 1]),
        lastCardResultKey:
          focusedBulkCardPageTraces[focusedBulkCardPageTraces.length - 1]?.lastResultKey ??
          buildCardDebugRecordKey(cardDebugRecords[cardDebugRecords.length - 1]),
      },
      counts: {
        users: {
          status: userCountProbe.status,
          count: userCountProbe.value,
          error: userCountProbe.error,
          rawResponse: userCountProbe.rawResponse,
        },
        cards: {
          status: cardCountProbe.status,
          count: cardCountProbe.value,
          error: cardCountProbe.error,
          rawResponse: cardCountProbe.rawResponse,
        },
      },
      capabilities: {
        status: capabilitiesProbe.status,
        error: capabilitiesProbe.error,
        rawResponse: capabilitiesProbe.rawResponse,
      },
    };

    for (const [probeIndex, focusedCardNo] of debugConfig.focusedCardNos.entries()) {
      const { probeRecord, directCardDebugRecords } = await probeFocusedCard({
        cardNo: focusedCardNo,
        maxResults,
        placeholderPattern,
        now,
        probeIndex,
      });

      focusedDirectCardProbes.push(probeRecord);

      const bulkCardRecord = cardDebugRecordsByCardNo.get(focusedCardNo) ?? null;
      const bulkUserRecord =
        bulkCardRecord?.canonicalEmployeeNo
          ? userDebugRecordsByJoinEmployeeNo.get(bulkCardRecord.canonicalEmployeeNo) ?? null
          : null;
      const directMatchingCardRecords = directCardDebugRecords.filter(
        (record) => record.cardNo === focusedCardNo
      );
      const directEmployeeProbeUserRecords = probeRecord.userProbes.flatMap(
        (userProbe) => userProbe.userRecords ?? []
      );

      const fuzzyCardProbe = await probeFocusedUserByFuzzySearch({
        query: focusedCardNo,
        purpose: 'focusedCardNo',
        maxResults,
        placeholderPattern,
        now,
        probeIndex,
      });
      const fuzzyPlaceholderProbes = await Promise.all(
        debugConfig.focusedPlaceholderNames.map((focusedPlaceholderName, placeholderIndex) =>
          probeFocusedUserByFuzzySearch({
            query: focusedPlaceholderName,
            purpose: 'focusedPlaceholderName',
            maxResults,
            placeholderPattern,
            now,
            probeIndex: probeIndex * Math.max(debugConfig.focusedPlaceholderNames.length, 1) + placeholderIndex,
          })
        )
      );
      const relevantFuzzyProbes = [fuzzyCardProbe, ...fuzzyPlaceholderProbes];

      focusedDirectUserFuzzyProbes.push(...relevantFuzzyProbes);

      const directFuzzyUserRecords = relevantFuzzyProbes.flatMap(
        (userProbe) => userProbe.userRecords ?? []
      );
      const directAllUserRecords = dedupeDirectUserRecords([
        ...directEmployeeProbeUserRecords,
        ...directFuzzyUserRecords,
      ]);
      const matchedFocusedSlotTokens = Array.from(
        new Set([
          ...focusedBulkUserRecords.flatMap((record) => [
            ...collectFocusedExactPlaceholderNames(debugConfig, record),
            ...collectFocusedSlotTokenPrefixes(debugConfig, record),
          ]),
          ...directAllUserRecords.flatMap((record) => [
            ...collectFocusedExactPlaceholderNames(debugConfig, record),
            ...collectFocusedSlotTokenPrefixes(debugConfig, record),
          ]),
          ...debugConfig.focusedPlaceholderNames,
        ].filter(Boolean))
      );
      const bulkHasFocusedEvidence =
        !!bulkCardRecord || focusedBulkUserRecords.length > 0;
      const directUserFuzzyHit = relevantFuzzyProbes.some((userProbe) => userProbe.status === 'found');
      const directUserFuzzyProbeUnsupported = relevantFuzzyProbes.some(
        (userProbe) => userProbe.status === 'unsupported'
      );
      const directUserFuzzyProbeError = relevantFuzzyProbes.some(
        (userProbe) => userProbe.status === 'error'
      );
      const classification = buildFocusedComparisonClassification({
        bulkHasFocusedEvidence,
        directCardProbeStatus: probeRecord.directCardProbeStatus,
        directUserFuzzyHit,
        directUserFuzzyProbeUnsupported,
        directUserFuzzyProbeError,
      });

      focusedComparisonRecords.push({
        key:
          matchedFocusedSlotTokens[0]
            ? `${focusedCardNo} • ${matchedFocusedSlotTokens[0]}`
            : focusedCardNo,
        cardNo: focusedCardNo,
        slotTokens: matchedFocusedSlotTokens,
        classification,
        bulkCardFound: !!bulkCardRecord,
        bulkFocusedUserSeen: focusedBulkUserRecords.length > 0,
        directCardProbeStatus: probeRecord.directCardProbeStatus,
        directCardProbeError: probeRecord.error,
        directUserFuzzyHit,
        bulkEmployeeNo: bulkCardRecord?.employeeNo ?? bulkUserRecord?.employeeNo ?? null,
        directEmployeeNos: Array.from(
          new Set(
            [
              ...directMatchingCardRecords.map((record) => record.canonicalEmployeeNo),
              ...directAllUserRecords.map((record) => record.canonicalEmployeeNo),
            ].filter(Boolean)
          )
        ),
        bulkUserName: bulkUserRecord?.extractedName ?? null,
        directUserNames: Array.from(
          new Set(
            directAllUserRecords
              .map((record) => record.extractedName)
              .filter(Boolean)
          )
        ),
        bulkSlotToken: bulkUserRecord?.slotToken ?? null,
        directSlotTokens: Array.from(
          new Set(
            directAllUserRecords
              .map((record) => record.slotToken)
              .filter(Boolean)
          )
        ),
        bulkCard: bulkCardRecord
          ? {
              employeeNo: bulkCardRecord.employeeNo || null,
              canonicalEmployeeNo: bulkCardRecord.canonicalEmployeeNo || null,
              rawCardInfo: createCompactCardSnippet(bulkCardRecord.rawCardInfo),
            }
          : null,
        bulkUser: bulkUserRecord
          ? {
              employeeNo: bulkUserRecord.employeeNo || null,
              canonicalEmployeeNo: bulkUserRecord.canonicalEmployeeNo || null,
              extractedName: bulkUserRecord.extractedName || null,
              slotToken: bulkUserRecord.slotToken || null,
              rawUserInfo: createCompactUserSnippet(bulkUserRecord.rawUserInfo),
            }
          : null,
        bulkFocusedUsers: focusedBulkUserRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          extractedName: record.extractedName || null,
          slotToken: record.slotToken || null,
          classification: record.classification,
          rawUserInfo: createCompactUserSnippet(record.rawUserInfo),
        })),
        directCards: directMatchingCardRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          rawCardInfo: createCompactCardSnippet(record.rawCardInfo),
        })),
        directUsers: directAllUserRecords.map((record) => ({
          employeeNo: record.employeeNo || null,
          canonicalEmployeeNo: record.canonicalEmployeeNo || null,
          extractedName: record.extractedName || null,
          slotToken: record.slotToken || null,
          classification: record.classification,
          rawUserInfo: createCompactUserSnippet(record.rawUserInfo),
        })),
        directUserFuzzyProbes: relevantFuzzyProbes.map((userProbe) => ({
          query: userProbe.query,
          purpose: userProbe.purpose,
          status: userProbe.status,
          returnedEmployeeNos: userProbe.returnedEmployeeNos,
          returnedNames: userProbe.returnedNames,
          error: userProbe.error,
        })),
      });
    }
  }

  console.info('[hik] listAvailableSlots diagnostics', diagnostics);

  if (availableSlotsDebugEnabled) {
    const cardBackedJoinEmployeeNos = new Set(cardsByEmployeeNo.keys());
    const focusedPlaceholderJoinEmployeeNos = new Set(
      userDebugRecords
        .filter((record) =>
          hasFocusedPlaceholderMatch(
            debugConfig,
            collectFocusedPlaceholderValues(record)
          )
        )
        .map((record) => record.canonicalEmployeeNo)
        .filter(Boolean)
    );
    const focusedCardJoinEmployeeNos = new Set(
      cardDebugRecords
        .filter((record) => isFocusedCardNoMatch(debugConfig, record.cardNo))
        .map((record) => record.canonicalEmployeeNo)
        .filter(Boolean)
    );
    const cardBackedNonSlotJoinEmployeeNos = new Set(
      cardBackedNonSlotRecords.map((record) => record.canonicalEmployeeNo).filter(Boolean)
    );

    const scannedUserRecordsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: userDebugRecords
        .filter((record) => {
          const isCardBacked =
            !!record.canonicalEmployeeNo &&
            cardBackedJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const hasPlaceholderEvidence =
            record.classification === 'validPlaceholder' ||
            record.classification === 'invalidValidity' ||
            record.classification === 'occupiedSlotName' ||
            record.matchingPlaceholderNames.length > 0 ||
            record.slotTokenCandidates.length > 0;
          const forceInclude =
            hasFocusedPlaceholderMatch(
              debugConfig,
              collectFocusedPlaceholderValues(record)
            ) ||
            (!!record.canonicalEmployeeNo &&
              focusedCardJoinEmployeeNos.has(record.canonicalEmployeeNo));

          return isCardBacked || hasPlaceholderEvidence || forceInclude;
        })
        .sort((left, right) => {
          const leftKey =
            left.slotToken ??
            left.placeholderNameHint ??
            left.extractedName ??
            left.employeeNo ??
            left.canonicalEmployeeNo;
          const rightKey =
            right.slotToken ??
            right.placeholderNameHint ??
            right.extractedName ??
            right.employeeNo ??
            right.canonicalEmployeeNo;

          return leftKey.localeCompare(rightKey);
        })
        .map((record) => {
          const isFocusedPlaceholder = hasFocusedPlaceholderMatch(
            debugConfig,
            collectFocusedPlaceholderValues(record)
          );
          const isFocusedCard =
            !!record.canonicalEmployeeNo &&
            focusedCardJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBacked =
            !!record.canonicalEmployeeNo &&
            cardBackedJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const debugMatchedBy = [];

          if (isFocusedPlaceholder) {
            debugMatchedBy.push('focusedPlaceholderName');
          }

          if (isFocusedCard) {
            debugMatchedBy.push('focusedCardNo');
          }

          if (isCardBacked) {
            debugMatchedBy.push('cardBackedEmployee');
          }

          if (record.matchingPlaceholderNames.length > 0) {
            debugMatchedBy.push('placeholderNameCandidate');
          }

          return {
            key:
              record.slotToken ??
              record.placeholderNameHint ??
              record.extractedName ??
              record.employeeNo ??
              '(missing employeeNo)',
            employeeNo: record.employeeNo || null,
            canonicalEmployeeNo: record.canonicalEmployeeNo || null,
            extractedName: record.extractedName || null,
            placeholderNameHint: record.placeholderNameHint,
            slotToken: record.slotToken,
            nameCandidates: record.nameCandidates,
            matchingPlaceholderNames: record.matchingPlaceholderNames,
            slotTokenCandidates: record.slotTokenCandidates,
            classification: record.classification,
            validityEvaluated: record.validityEvaluated,
            isCurrentlyValid: record.isCurrentlyValid,
            validityReason: record.validityReason,
            normalizedValidity: record.normalizedValidity,
            debugMatchedBy,
            rawUserInfo: record.rawUserInfo,
            forceInclude: isFocusedPlaceholder || isFocusedCard,
          };
        }),
    });
    const scannedCardRecordsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: cardDebugRecords
        .filter((record) => {
          const isFocusedCard = isFocusedCardNoMatch(debugConfig, record.cardNo);
          const isFocusedPlaceholder =
            !!record.canonicalEmployeeNo &&
            focusedPlaceholderJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBackedNonSlot =
            !!record.canonicalEmployeeNo &&
            cardBackedNonSlotJoinEmployeeNos.has(record.canonicalEmployeeNo);

          return isFocusedCard || isFocusedPlaceholder || isCardBackedNonSlot;
        })
        .sort((left, right) => left.cardNo.localeCompare(right.cardNo))
        .map((record) => {
          const isFocusedCard = isFocusedCardNoMatch(debugConfig, record.cardNo);
          const isFocusedPlaceholder =
            !!record.canonicalEmployeeNo &&
            focusedPlaceholderJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const isCardBackedNonSlot =
            !!record.canonicalEmployeeNo &&
            cardBackedNonSlotJoinEmployeeNos.has(record.canonicalEmployeeNo);
          const debugMatchedBy = [];

          if (isFocusedCard) {
            debugMatchedBy.push('focusedCardNo');
          }

          if (isFocusedPlaceholder) {
            debugMatchedBy.push('focusedPlaceholderName');
          }

          if (isCardBackedNonSlot) {
            debugMatchedBy.push('cardBackedNonSlot');
          }

          return {
            key: record.cardNo,
            cardNo: record.cardNo,
            employeeNo: record.employeeNo || null,
            canonicalEmployeeNo: record.canonicalEmployeeNo || null,
            debugMatchedBy,
            rawCardInfo: record.rawCardInfo,
            forceInclude: isFocusedCard || isFocusedPlaceholder,
          };
        }),
    });
    const cardBackedNonSlotsReport = buildDebugReport({
      focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
      focusedCardNos: debugConfig.focusedCardNos,
      records: cardBackedNonSlotRecords,
    });

    logDebugJson(
      '[hik] listAvailableSlots scanned user records',
      scannedUserRecordsReport
    );
    logDebugJson(
      '[hik] listAvailableSlots scanned card records',
      scannedCardRecordsReport
    );
    logDebugJson(
      '[hik] listAvailableSlots card-backed non-slots',
      cardBackedNonSlotsReport
    );

    if (focusedDirectProbeEnabled) {
      logDebugJson('[hik] listAvailableSlots focused device evidence', focusedDeviceEvidence);
      logDebugJson('[hik] listAvailableSlots focused bulk page trace', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        userPages: focusedBulkUserPageTraces,
        cardPages: focusedBulkCardPageTraces,
      });
      logDebugJson('[hik] listAvailableSlots focused direct card probes', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        probes: focusedDirectCardProbes,
      });
      logDebugJson('[hik] listAvailableSlots focused direct user fuzzy probes', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        probes: focusedDirectUserFuzzyProbes,
      });
      logDebugJson('[hik] listAvailableSlots focused comparison report', {
        focusedPlaceholderNames: debugConfig.focusedPlaceholderNames,
        focusedCardNos: debugConfig.focusedCardNos,
        records: focusedComparisonRecords,
      });
    }
  }

  return {
    slots,
    diagnostics,
  };
}

export async function resetSlot({ employeeNo, placeholderName, now = new Date() }) {
  return await addUser({
    employeeNo,
    name: placeholderName,
    userType: 'normal',
    beginTime: `${formatDatePart(now)}T00:00:00`,
    endTime: getResetSlotEndTime(),
  });
}
