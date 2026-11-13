import { eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db";
import { bookingConfirmationTemplates } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import type { BookingConfirmationTemplate } from "./confirmation-utils";

type Db = ReturnType<typeof getDb>;

/** Thrown when a custom confirmation is saved before the migration that adds its table or column. */
export class ConfirmationTemplatesUnavailableError extends Error {
	constructor() {
		super("Apply the pending database migration (Admin → Overview) before customizing the confirmation email.");
	}
}

/** Custom confirmations by booking event id. Before migration 0086 there are none; before 0087 no guest opt-in. */
export async function getConfirmationTemplates(db: Db, eventIds: string[]): Promise<Map<string, BookingConfirmationTemplate>> {
	if (!eventIds.length) return new Map();
	const table = bookingConfirmationTemplates;
	try {
		try {
			const rows = await db.select({ eventId: table.eventId, subject: table.subject, body: table.body, notifyGuests: table.notifyGuests }).from(table).where(inArray(table.eventId, eventIds));
			return new Map(rows.map((row) => [row.eventId, { subject: row.subject, body: row.body, notifyGuests: !!row.notifyGuests }]));
		} catch (error) {
			if (!isMissingColumnError(error)) throw error;
			const rows = await db.select({ eventId: table.eventId, subject: table.subject, body: table.body }).from(table).where(inArray(table.eventId, eventIds));
			return new Map(rows.map((row) => [row.eventId, { subject: row.subject, body: row.body, notifyGuests: false }]));
		}
	} catch (error) {
		if (isMissingTableError(error)) return new Map();
		throw error;
	}
}

/** Saves an event's confirmation; with no subject, body or guest opt-in the row goes, so the built-in text is used again. */
export async function saveConfirmationTemplate(db: Db, eventId: string, template: BookingConfirmationTemplate): Promise<void> {
	const table = bookingConfirmationTemplates;
	const notifyGuests = !!template.notifyGuests;
	try {
		if (!template.subject && !template.body && !notifyGuests) {
			await db.delete(table).where(eq(table.eventId, eventId));
			return;
		}
		const values = { subject: template.subject, body: template.body, updatedAt: new Date() };
		try {
			await db.insert(table).values({ eventId, ...values, notifyGuests }).onConflictDoUpdate({ target: table.eventId, set: { ...values, notifyGuests } });
		} catch (error) {
			// Before migration 0087 the text can still be saved; only turning guest emails on needs the column.
			if (!isMissingColumnError(error) || notifyGuests) throw error;
			await db.insert(table).values({ eventId, ...values }).onConflictDoUpdate({ target: table.eventId, set: values });
		}
	} catch (error) {
		if (!isMissingTableError(error) && !isMissingColumnError(error)) throw error;
		if (template.subject || template.body || notifyGuests) throw new ConfirmationTemplatesUnavailableError();
	}
}

/** Adds each event's confirmationSubject, confirmationBody and confirmationNotifyGuests, empty where it has none. */
export async function withConfirmationTemplates<T extends { id: string }>(db: Db, events: T[]): Promise<(T & { confirmationSubject: string; confirmationBody: string; confirmationNotifyGuests: boolean })[]> {
	const templates = await getConfirmationTemplates(db, events.map((event) => event.id));
	return events.map((event) => {
		const template = templates.get(event.id);
		return { ...event, confirmationSubject: template?.subject ?? "", confirmationBody: template?.body ?? "", confirmationNotifyGuests: !!template?.notifyGuests };
	});
}
