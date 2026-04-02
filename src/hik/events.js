import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';

const MEMBER_EVENTS_START_TIME = '2020-01-01T00:00:00';
const MEMBER_EVENTS_END_TIME = '2099-12-31T23:59:59';

export async function getMemberEvents({
  employeeNoString,
  maxResults = SEARCH_PAGE_SIZE,
  searchResultPosition = 0,
}) {
  const normalizedEmployeeNoString =
    typeof employeeNoString === 'string' ? employeeNoString.trim() : '';

  const response = await performIsapiRequest('/ISAPI/AccessControl/AcsEvent?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      AcsEventCond: {
        searchID: '1',
        searchResultPosition,
        maxResults,
        major: 5,
        minor: 0,
        startTime: MEMBER_EVENTS_START_TIME,
        endTime: MEMBER_EVENTS_END_TIME,
        employeeNoString: normalizedEmployeeNoString,
      },
    }),
  });

  return response?.AcsEvent ?? response;
}
