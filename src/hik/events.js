import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';

const MEMBER_EVENTS_START_TIME = '2020-01-01T00:00:00';

export async function getMemberEvents({
  employeeNoString,
  maxResults = SEARCH_PAGE_SIZE,
  searchID = Date.now().toString(),
  searchResultPosition = 0,
}) {
  const normalizedEmployeeNoString =
    typeof employeeNoString === 'string' ? employeeNoString.trim() : '';
  const memberEventsEndYear = new Date().getFullYear() + 1;
  const memberEventsEndTime = `${memberEventsEndYear}-12-31T23:59:59`;

  const response = await performIsapiRequest('/ISAPI/AccessControl/AcsEvent?format=json', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      AcsEventCond: {
        searchID,
        searchResultPosition,
        maxResults,
        major: 5,
        minor: 0,
        startTime: MEMBER_EVENTS_START_TIME,
        endTime: memberEventsEndTime,
        employeeNoString: normalizedEmployeeNoString,
      },
    }),
  });

  return response?.AcsEvent ?? response;
}
