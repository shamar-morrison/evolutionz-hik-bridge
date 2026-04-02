import { SEARCH_PAGE_SIZE } from './constants.js';
import { performIsapiRequest, jsonHeaders } from './client.js';

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
        employeeNoString: normalizedEmployeeNoString,
      },
    }),
  });

  return response?.AcsEvent ?? response;
}
