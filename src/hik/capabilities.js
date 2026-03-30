import { performIsapiRequest } from './client.js';

export async function getCapabilities() {
  return await performIsapiRequest('/ISAPI/AccessControl/capabilities');
}
