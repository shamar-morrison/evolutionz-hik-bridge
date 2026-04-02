import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';
import { formatDatePart, pad } from './shared.js';

const MEMBER_EVENTS_START_TIME = '2020-01-01T00:00:00';

function formatLocalDateTime(date) {
  return `${formatDatePart(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function getMemberEvents({
  employeeNoString,
  maxResults = SEARCH_PAGE_SIZE,
  searchResultPosition = 0,
}) {
  const normalizedEmployeeNoString =
    typeof employeeNoString === 'string' ? employeeNoString.trim() : '';
  const endTime = formatLocalDateTime(new Date());

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
        endTime,
        employeeNoString: normalizedEmployeeNoString,
      },
    }),
  });

  return response?.AcsEvent ?? response;
}
