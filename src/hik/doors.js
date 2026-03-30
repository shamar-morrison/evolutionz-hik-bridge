import { REMOTE_CONTROL_PASSWORD_PATTERN } from './constants.js';
import { performIsapiRequest, xmlHeaders } from './client.js';

function getRemoteDoorPassword() {
  const remotePassword = process.env.HIK_REMOTE_PASSWORD?.trim();

  if (!REMOTE_CONTROL_PASSWORD_PATTERN.test(remotePassword ?? '')) {
    const message = 'Bridge misconfiguration: HIK_REMOTE_PASSWORD must be set to a 6-digit code for unlock_door';
    console.error(`[hik] ${message}`);
    throw new Error(message);
  }

  return remotePassword;
}

function buildUnlockDoorBody(remotePassword) {
  return `<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><cmd>open</cmd><remotePassword>${remotePassword}</remotePassword></RemoteControlDoor>`;
}

export async function unlockDoor(doorNo = 1) {
  const remotePassword = getRemoteDoorPassword();
  return await performIsapiRequest(`/ISAPI/AccessControl/RemoteControl/door/${doorNo}`, {
    method: 'PUT',
    headers: xmlHeaders(),
    body: buildUnlockDoorBody(remotePassword),
  });
}
