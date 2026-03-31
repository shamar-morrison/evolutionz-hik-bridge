// src/jobs.js
// Processes access control jobs from the Supabase queue

import * as hik from './hik.js';
import { buildUserInfoPayload } from './hik/users.js';
import { toBoolean } from './hik/shared.js';
import { getUserModifyMode } from './hik/config.js';

const WRITE_JOB_ROUTES = {
  add_user: '/ISAPI/AccessControl/UserInfo/SetUp?format=json',
  add_card: '/ISAPI/AccessControl/CardInfo/SetUp?format=json',
};

function shouldLogWritePayloadDiagnostics() {
  return toBoolean(process.env.HIK_DEBUG_WRITE_PAYLOADS, false);
}

function normalizeLogString(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function buildWritePayloadSummary(jobType, payload) {
  const name = normalizeLogString(payload?.name);
  const userInfoPayload =
    jobType === 'add_user'
      ? buildUserInfoPayload({
          employeeNo: payload?.employeeNo,
          name: payload?.name,
          userType: payload?.userType ?? 'normal',
          beginTime: payload?.beginTime,
          endTime: payload?.endTime,
          mode: getUserModifyMode(),
        })
      : null;

  return {
    employeeNo: normalizeLogString(payload?.employeeNo),
    name,
    nameLength: name ? name.length : null,
    beginTime: normalizeLogString(payload?.beginTime),
    endTime: normalizeLogString(payload?.endTime),
    cardNo: normalizeLogString(payload?.cardNo),
    payloadMode: userInfoPayload ? getUserModifyMode() : null,
    userType: typeof userInfoPayload?.userType === 'string' ? userInfoPayload.userType : null,
    doorRight:
      typeof userInfoPayload?.doorRight === 'string' ? userInfoPayload.doorRight : null,
    RightPlan: Array.isArray(userInfoPayload?.RightPlan) ? userInfoPayload.RightPlan : null,
  };
}

function extractRawDeviceErrorBody(errorMessage) {
  if (typeof errorMessage !== 'string' || !errorMessage.startsWith('Device returned ')) {
    return errorMessage ?? null;
  }

  const separatorIndex = errorMessage.indexOf(': ');

  if (separatorIndex < 0) {
    return errorMessage;
  }

  return errorMessage.slice(separatorIndex + 2);
}

function logWriteFailureDiagnostics(jobType, payload, error) {
  if (!shouldLogWritePayloadDiagnostics()) {
    return;
  }

  const diagnostics = {
    jobType,
    route: WRITE_JOB_ROUTES[jobType] ?? null,
    payloadSummary: buildWritePayloadSummary(jobType, payload),
    rawDeviceErrorBody:
      extractRawDeviceErrorBody(error instanceof Error ? error.message : String(error)),
  };

  console.error(`[hik] ${jobType} write failure diagnostics\n${JSON.stringify(diagnostics, null, 2)}`);
}

/**
 * Process a single job from the access_control_jobs table.
 * Returns { success: true, result } or throws an error.
 *
 * Job types:
 *   unlock_door   - payload: { doorNo? }
 *   add_user      - payload: { employeeNo, name, beginTime, endTime }
 *   delete_user   - payload: { employeeNo }
 *   get_user      - payload: { employeeNo }
 *   add_card      - payload: { employeeNo, cardNo }
 *   revoke_card   - payload: { employeeNo, cardNo }
 *   get_card      - payload: { cardNo } or { employeeNo }
 *   list_available_cards - payload: {}
 *   list_available_slots - payload: {}
 *   sync_all_members - payload: {}
 *   reset_slot    - payload: { employeeNo, placeholderName }
 */
export async function processJob(job, hikApi = hik) {
  const { type, payload } = job;

  console.log(`[jobs] Processing job type="${type}" id=${job.id}`);

  switch (type) {
    case 'unlock_door': {
      const result = await hikApi.unlockDoor(payload.doorNo ?? 1);
      return { success: true, result };
    }

    case 'add_user': {
      try {
        const result = await hikApi.addUser({
          employeeNo: payload.employeeNo,
          name: payload.name,
          userType: payload.userType ?? 'normal',
          beginTime: payload.beginTime,
          endTime: payload.endTime,
        });
        return { success: true, result };
      } catch (error) {
        logWriteFailureDiagnostics(type, payload, error);
        throw error;
      }
    }

    case 'delete_user': {
      const result = await hikApi.deleteUser(payload.employeeNo);
      return { success: true, result };
    }

    case 'get_user': {
      const result = await hikApi.getUser(payload.employeeNo);
      return { success: true, result };
    }

    case 'add_card': {
      try {
        const result = await hikApi.addCard(payload.employeeNo, payload.cardNo);
        return { success: true, result };
      } catch (error) {
        logWriteFailureDiagnostics(type, payload, error);
        throw error;
      }
    }

    case 'revoke_card': {
      const result = await hikApi.revokeCard(payload.employeeNo, payload.cardNo);
      return { success: true, result };
    }

    case 'get_card': {
      const result = await hikApi.getCard(payload);
      return { success: true, result };
    }

    case 'list_available_cards': {
      const result = await hikApi.listAvailableCards();
      return { success: true, result };
    }

    case 'list_available_slots': {
      const result = await hikApi.listAvailableSlots();
      return { success: true, result };
    }

    case 'sync_all_members': {
      const result = await hikApi.syncAllMembers(payload);
      return { success: true, result };
    }

    case 'reset_slot': {
      const result = await hikApi.resetSlot({
        employeeNo: payload.employeeNo,
        placeholderName: payload.placeholderName,
      });
      return { success: true, result };
    }

    default:
      throw new Error(`Unknown job type: "${type}"`);
  }
}
