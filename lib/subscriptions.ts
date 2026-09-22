import fs from 'fs/promises';
import path from 'path';

const SUBS_PATH = path.join(process.cwd(), 'data', 'subscriptions.json');
const SCHEDULES_PATH = path.join(process.cwd(), 'data', 'schedules.json');

async function readJson(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeJson(filePath: string, data: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function getAllSubscriptions() {
  return (await readJson(SUBS_PATH)) as any[];
}

export async function addSubscription(subscription: any) {
  const subs = await getAllSubscriptions();
  const exists = subs.find((s: any) => s.endpoint === subscription.endpoint);
  if (exists) {
    // update
    const updated = subs.map((s: any) => (s.endpoint === subscription.endpoint ? { ...s, ...subscription } : s));
    await writeJson(SUBS_PATH, updated);
    return updated;
  }

  subs.push(subscription);
  await writeJson(SUBS_PATH, subs);
  return subs;
}

export async function removeSubscriptionByEndpoint(endpoint: string) {
  const subs = await getAllSubscriptions();
  const filtered = subs.filter((s: any) => s.endpoint !== endpoint);
  await writeJson(SUBS_PATH, filtered);
  return filtered;
}

// Schedules
export type ScheduleEntry = {
  id: string;
  subscriptionEndpoint: string; // which subscription to target
  type: 'subject' | 'backup';
  payload: any; // data used to construct notification and click behavior
  // One-off notification time (ISO) - used for single subject reminders
  notifyAt?: string;
  // Recurring weekly schedule fields (for subject reminders saved from UI)
  day?: number; // 0=Sunday..6=Saturday
  startTime?: string; // "HH:MM" 24h
  endTime?: string; // "HH:MM" 24h
  notifyOffset?: number; // minutes
  notifyWhen?: 'before' | 'after';

  /** The reminder's id inside the app, so editing or deleting it there updates this entry instead of adding another */
  clientId?: string;

  createdAt: string;
  // For one-off subject reminders we mark sent=true after delivery.
  // Recurring entries keep sent=false or undefined.
  sent?: boolean;
};

export async function getAllSchedules(): Promise<ScheduleEntry[]> {
  return (await readJson(SCHEDULES_PATH)) as ScheduleEntry[];
}

export async function addSchedule(entry: Omit<ScheduleEntry, 'id' | 'createdAt' | 'sent'>) {
  const schedules = await getAllSchedules();
  const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const newEntry: ScheduleEntry = {
    id,
    ...entry,
    createdAt: new Date().toISOString(),
    sent: false,
  };
  schedules.push(newEntry);
  await writeJson(SCHEDULES_PATH, schedules);
  return newEntry;
}

/** Adds a reminder, or updates the one this device already saved under the same clientId */
export async function upsertSchedule(entry: Omit<ScheduleEntry, 'id' | 'createdAt' | 'sent'> & { clientId: string }) {
  const schedules = await getAllSchedules();
  const at = schedules.findIndex((s) => s.subscriptionEndpoint === entry.subscriptionEndpoint && s.clientId === entry.clientId);
  if (at !== -1) {
    schedules[at] = { ...schedules[at], ...entry, sent: false };
    await writeJson(SCHEDULES_PATH, schedules);
    return schedules[at];
  }
  const created: ScheduleEntry = { id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`, ...entry, createdAt: new Date().toISOString(), sent: false };
  schedules.push(created);
  await writeJson(SCHEDULES_PATH, schedules);
  return created;
}

export async function removeScheduleByClientId(subscriptionEndpoint: string, clientId: string) {
  const schedules = await getAllSchedules();
  const kept = schedules.filter((s) => !(s.subscriptionEndpoint === subscriptionEndpoint && s.clientId === clientId));
  await writeJson(SCHEDULES_PATH, kept);
  return schedules.length - kept.length;
}

export async function markScheduleSent(id: string) {
  const schedules = await getAllSchedules();
  const updated = schedules.map(s => (s.id === id ? { ...s, sent: true } : s));
  await writeJson(SCHEDULES_PATH, updated);
  return updated;
}

const subscriptions = {
  getAllSubscriptions,
  addSubscription,
  removeSubscriptionByEndpoint,
  getAllSchedules,
  addSchedule,
  upsertSchedule,
  removeScheduleByClientId,
  markScheduleSent,
};

export default subscriptions;
