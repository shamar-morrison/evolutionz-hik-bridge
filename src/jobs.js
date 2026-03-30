// src/jobs.js
// Processes access control jobs from the Supabase queue

import * as hik from './hik.js';

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
 *   get_card      - payload: { employeeNo }
 *   list_available_cards - payload: {}
 *   list_available_slots - payload: {}
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
      const result = await hikApi.addUser({
        employeeNo: payload.employeeNo,
        name: payload.name,
        userType: payload.userType ?? 'normal',
        beginTime: payload.beginTime,
        endTime: payload.endTime,
      });
      return { success: true, result };
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
      const result = await hikApi.addCard(payload.employeeNo, payload.cardNo);
      return { success: true, result };
    }

    case 'revoke_card': {
      const result = await hikApi.revokeCard(payload.employeeNo, payload.cardNo);
      return { success: true, result };
    }

    case 'get_card': {
      const result = await hikApi.getCard(payload.employeeNo);
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
