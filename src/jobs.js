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
 */
export async function processJob(job) {
  const { type, payload } = job;

  console.log(`[jobs] Processing job type="${type}" id=${job.id}`);

  switch (type) {
    case 'unlock_door': {
      const result = await hik.unlockDoor(payload.doorNo ?? 1);
      return { success: true, result };
    }

    case 'add_user': {
      const result = await hik.addUser({
        employeeNo: payload.employeeNo,
        name: payload.name,
        userType: payload.userType ?? 'normal',
        beginTime: payload.beginTime,
        endTime: payload.endTime,
      });
      return { success: true, result };
    }

    case 'delete_user': {
      const result = await hik.deleteUser(payload.employeeNo);
      return { success: true, result };
    }

    case 'get_user': {
      const result = await hik.getUser(payload.employeeNo);
      return { success: true, result };
    }

    case 'add_card': {
      // First make sure the user exists on the device, then issue the card
      const result = await hik.addCard(payload.employeeNo, payload.cardNo);
      return { success: true, result };
    }

    case 'revoke_card': {
      const result = await hik.revokeCard(payload.employeeNo, payload.cardNo);
      return { success: true, result };
    }

    case 'get_card': {
      const result = await hik.getCard(payload.employeeNo);
      return { success: true, result };
    }

    default:
      throw new Error(`Unknown job type: "${type}"`);
  }
}
