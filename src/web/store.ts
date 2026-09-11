import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { ensureRayaHome, RAYA_WEB_PATH } from "../config/paths.js";
import { writePrivateFileAtomic } from "../storage/atomic-file.js";

const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  createdAt: z.number().finite()
});

const CalendarEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }).optional(),
  notes: z.string().default(""),
  workspaceId: z.string().optional()
});

const NoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(""),
  updatedAt: z.number().finite()
});

const BrowserNotificationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  createdAt: z.number().finite(),
  read: z.boolean().default(false)
});

const WebDataSchema = z.object({
  workspaces: z.array(WorkspaceSchema).default([]),
  calendar: z.array(CalendarEventSchema).default([]),
  notes: z.array(NoteSchema).default([]),
  notifications: z.array(BrowserNotificationSchema).default([])
});

export type WebWorkspace = z.infer<typeof WorkspaceSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type RayaNote = z.infer<typeof NoteSchema>;
export type BrowserNotification = z.infer<typeof BrowserNotificationSchema>;
export type WebData = z.infer<typeof WebDataSchema>;

export function loadWebData(): WebData {
  ensureRayaHome();
  if (!existsSync(RAYA_WEB_PATH)) return WebDataSchema.parse({});
  return WebDataSchema.parse(JSON.parse(readFileSync(RAYA_WEB_PATH, "utf8")));
}

function saveWebData(data: WebData): WebData {
  ensureRayaHome();
  const parsed = WebDataSchema.parse(data);
  writePrivateFileAtomic(RAYA_WEB_PATH, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function addWorkspace(name: string, path: string): WebWorkspace {
  const requestedPath = resolve(path.trim());
  if (!existsSync(requestedPath)) throw new Error(`Workspace does not exist: ${requestedPath}`);
  if (!lstatSync(requestedPath).isDirectory()) throw new Error(`Workspace must be a directory: ${requestedPath}`);
  const absolutePath = realpathSync(requestedPath);
  const data = loadWebData();
  const existing = data.workspaces.find((item) => item.path === absolutePath);
  if (existing) return existing;
  const workspace = WorkspaceSchema.parse({
    id: randomUUID().slice(0, 8),
    name: name.trim() || basename(absolutePath) || absolutePath,
    path: absolutePath,
    createdAt: Date.now()
  });
  data.workspaces.push(workspace);
  saveWebData(data);
  return workspace;
}

export function removeWorkspace(id: string): void {
  const data = loadWebData();
  data.workspaces = data.workspaces.filter((item) => item.id !== id);
  saveWebData(data);
}

export function saveCalendarEvent(input: Omit<CalendarEvent, "id"> & { id?: string }): CalendarEvent {
  const data = loadWebData();
  const event = CalendarEventSchema.parse({ ...input, id: input.id || randomUUID().slice(0, 8) });
  const index = data.calendar.findIndex((item) => item.id === event.id);
  if (index >= 0) data.calendar[index] = event;
  else data.calendar.push(event);
  saveWebData(data);
  return event;
}

export function deleteCalendarEvent(id: string): void {
  const data = loadWebData();
  data.calendar = data.calendar.filter((item) => item.id !== id);
  saveWebData(data);
}

export function saveNote(input: { id?: string; title: string; body?: string }): RayaNote {
  const data = loadWebData();
  const note = NoteSchema.parse({
    id: input.id || randomUUID().slice(0, 8),
    title: input.title.trim(),
    body: input.body ?? "",
    updatedAt: Date.now()
  });
  const index = data.notes.findIndex((item) => item.id === note.id);
  if (index >= 0) data.notes[index] = note;
  else data.notes.push(note);
  saveWebData(data);
  return note;
}

export function deleteNote(id: string): void {
  const data = loadWebData();
  data.notes = data.notes.filter((item) => item.id !== id);
  saveWebData(data);
}

export function pushBrowserNotification(title: string, body: string): BrowserNotification {
  const data = loadWebData();
  const notification = BrowserNotificationSchema.parse({
    id: randomUUID().slice(0, 8),
    title,
    body,
    createdAt: Date.now(),
    read: false
  });
  data.notifications.push(notification);
  data.notifications = data.notifications.slice(-100);
  saveWebData(data);
  return notification;
}

export function markNotificationsRead(ids: string[]): void {
  const selected = new Set(ids);
  const data = loadWebData();
  for (const item of data.notifications) if (selected.has(item.id)) item.read = true;
  saveWebData(data);
}
