import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';
import { getUserModifyMode } from './config.js';
import { normalizeList } from './shared.js';

export function buildUserInfoPayload({
  employeeNo,
  name,
  userType = 'normal',
  beginTime,
  endTime,
  mode = getUserModifyMode(),
}) {
  const payload = {
    employeeNo: String(employeeNo),
    name,
    userType,
  };

  if (mode === 'minimal') {
    return payload;
  }

  payload.Valid = {
    enable: true,
    beginTime,
    endTime,
  };

  if (mode === 'valid_only') {
    return payload;
  }

  payload.doorRight = '1';
  payload.RightPlan = [{ doorNo: 1, planTemplateNo: '1' }];

  return payload;
}

export async function addUser({ employeeNo, name, userType = 'normal', beginTime, endTime }) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/SetUp?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfo: buildUserInfoPayload({
        employeeNo,
        name,
        userType,
        beginTime,
        endTime,
      }),
    }),
  });
}

export async function deleteUser(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Delete?format=json', {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoDelCond: {
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

export async function getUser(employeeNo) {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoSearchCond: {
        searchID: '1',
        searchResultPosition: 0,
        maxResults: 1,
        EmployeeNoList: [{ employeeNo: String(employeeNo) }],
      },
    }),
  });
}

export function normalizeUserInfoList(userInfo) {
  return normalizeList(userInfo);
}

export async function searchUsers({
  searchID,
  searchResultPosition,
  maxResults = SEARCH_PAGE_SIZE,
  employeeNos = [],
  fuzzySearch = '',
}) {
  const normalizedEmployeeNos = employeeNos
    .map((employeeNo) => String(employeeNo).trim())
    .filter(Boolean);
  const normalizedFuzzySearch =
    typeof fuzzySearch === 'string' ? fuzzySearch.trim() : '';

  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Search?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      UserInfoSearchCond: {
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
        ...(normalizedFuzzySearch ? { fuzzySearch: normalizedFuzzySearch } : {}),
      },
    }),
  });
}

export async function getUserCount() {
  return await performIsapiRequest('/ISAPI/AccessControl/UserInfo/Count?format=json');
}
