import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';
import {
  getNumericField,
  normalizeList,
  normalizeSearchMetadata,
  shouldContinuePagedSearch,
} from './shared.js';

export async function addCard(employeeNo, cardNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/SetUp?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfo: {
        employeeNo: String(employeeNo),
        cardNo: String(cardNo),
        cardType: 'normalCard',
      },
    }),
  });
}

export async function revokeCard(employeeNo, cardNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Delete?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoDelCond: {
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

export async function getCard(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoSearchCond: {
        searchID: '1',
        searchResultPosition: 0,
        maxResults: 10,
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

export function normalizeCardInfoList(cardInfo) {
  return normalizeList(cardInfo);
}

export async function searchCards({
  searchID,
  searchResultPosition,
  maxResults = SEARCH_PAGE_SIZE,
  employeeNos = [],
  cardNos = [],
}) {
  const normalizedEmployeeNos = employeeNos
    .map((employeeNo) => String(employeeNo).trim())
    .filter(Boolean);
  const normalizedCardNos = cardNos
    .map((cardNo) => String(cardNo).trim())
    .filter(Boolean);

  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      CardInfoSearchCond: {
        searchID,
        searchResultPosition,
        maxResults,
        ...(normalizedEmployeeNos.length > 0
          ? {
              EmployeeNoList: normalizedEmployeeNos.map((employeeNo) => ({
                employeeNo,
              })),
            }
          : {}),
        ...(normalizedCardNos.length > 0
          ? {
              CardNoList: normalizedCardNos.map((cardNo) => ({
                cardNo,
              })),
            }
          : {}),
      },
    }),
  });
}

export async function listAvailableCards({ maxResults = SEARCH_PAGE_SIZE } = {}) {
  const cardsByNumber = new Map();
  const searchID = `evolutionz-${Date.now()}`;
  let searchResultPosition = 0;

  while (true) {
    const response = await searchCards({
      searchID,
      searchResultPosition,
      maxResults,
    });
    const cardInfoSearch = response?.CardInfoSearch;

    if (!cardInfoSearch || typeof cardInfoSearch !== 'object') {
      throw new Error('Device returned an unexpected card search response.');
    }

    const cardInfoList = normalizeCardInfoList(cardInfoSearch.CardInfo);

    for (const cardInfo of cardInfoList) {
      const cardNo = typeof cardInfo?.cardNo === 'string' ? cardInfo.cardNo.trim() : '';
      const employeeNo =
        typeof cardInfo?.employeeNo === 'string' ? cardInfo.employeeNo.trim() : '';

      if (!cardNo || employeeNo) {
        continue;
      }

      cardsByNumber.set(cardNo, { cardNo });
    }

    const searchMetadata = normalizeSearchMetadata(cardInfoSearch, cardInfoList.length);
    const totalMatches = getNumericField(
      searchMetadata.totalMatches,
      searchResultPosition + searchMetadata.numOfMatches
    );

    if (!shouldContinuePagedSearch({
      responseStatus: searchMetadata.responseStatusStrg,
      searchResultPosition,
      matchesOnPage: searchMetadata.numOfMatches,
      totalMatches,
    })) {
      break;
    }

    searchResultPosition += searchMetadata.numOfMatches;
  }

  return {
    cards: Array.from(cardsByNumber.values()).sort((left, right) =>
      left.cardNo.localeCompare(right.cardNo)
    ),
  };
}

export async function getCardCount() {
  return await performIsapiRequest('/ISAPI/AccessControl/CardInfo/Count?format=json');
}
