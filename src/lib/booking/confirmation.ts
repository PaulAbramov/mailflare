import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import { mailboxAddress } from "@/lib/profile/identity-utils";
import { buildBookingCalendarFile, buildBookingConfirmation, MAX_NOTIFIED_GUESTS, type BookingConfirmationContent } from "./confirmation-utils";
import { getConfirmationTemplates } from "./confirmation-templates";
import type { BookingEventRecord } from "./types";

/** The event owner's own mailbox: the one at their account address, else their oldest personal one. */
async function findHostMailbox(env: CloudflareEnv, userId: string): Promise<{ id: string; address: string } | null> {
	const db = getDb(env);
	const rows = await db
		.select({ id: mailboxes.id, localPart: mailboxes.localPart, hostname: domains.hostname, accountEmail: users.email })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(and(eq(mailboxes.userId, userId), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)))
		.orderBy(asc(mailboxes.createdAt));
	const chosen = rows.find((row) => mailboxAddress(row) === row.accountEmail?.trim().toLowerCase()) ?? rows[0];
	return chosen ? { id: chosen.id, address: mailboxAddress(chosen) } : null;
}

/**
 * Emails the booker a confirmation with an invite.ics, from the event owner's mailbox, so replies reach the host and
 * a Sent copy is kept. The booker's name and notes are neutralized first (see neutralizeBookerText): the public page
 * does not verify who books.
 *
 * Guests the booker added are mailed only when the host turned that on for the event, at most MAX_NOTIFIED_GUESTS of
 * them, each one charged to the client's rate-limit budget (allowGuestMail), and in a separate message without the
 * booker's notes. Delivery goes through the outbound queue a few seconds later, keeping the public booking request
 * light. Never throws: the booking already stands.
 */
export async function sendBookingConfirmation(
	env: CloudflareEnv,
	input: {
		event: BookingEventRecord;
		hostName: string;
		guestName: string;
		guestEmail: string;
		guestEmails?: string[];
		notes: string;
		startsAt: string;
		endsAt: string;
		locale?: string;
		publicOrigin?: string;
		allowGuestMail?: () => Promise<boolean>;
	},
): Promise<boolean> {
	try {
		const mailbox = await findHostMailbox(env, input.event.userId);
		if (!mailbox) {
			console.warn("Booking confirmation skipped: the event owner has no personal mailbox", { eventId: input.event.id });
			return false;
		}
		const startsAt = new Date(input.startsAt);
		const endsAt = new Date(input.endsAt);
		const template = (await getConfirmationTemplates(getDb(env), [input.event.id])).get(input.event.id);
		const content: BookingConfirmationContent = {
			eventName: input.event.name,
			hostName: input.hostName,
			guestName: input.guestName,
			location: input.event.location,
			notes: input.notes,
			startsAt,
			endsAt,
			timeZone: input.event.timeZone,
		};
		const send = async (to: string | string[], includeNotes: boolean) => {
			const { subject, text } = buildBookingConfirmation(content, input.locale, template, { includeNotes });
			const invite = buildBookingCalendarFile({
				// Worded without language so it reads the same whatever text the host chose.
				title: `${input.event.name} (${input.hostName})`,
				description: input.event.description || text,
				location: input.event.location,
				startsAt,
				endsAt,
				uid: newId("bkg"),
			});
			await sendEmail(env, {
				userId: input.event.userId,
				mailboxId: mailbox.id,
				from: mailbox.address,
				to,
				subject,
				text,
				attachments: [{ filename: "invite.ics", type: "text/calendar; charset=utf-8", content: invite }],
				scheduledAt: new Date(Date.now() + 5_000),
				publicOrigin: input.publicOrigin,
			});
		};
		await send(input.guestEmail, true);
		if (template?.notifyGuests && input.guestEmails?.length) {
			const guests: string[] = [];
			for (const guest of input.guestEmails.slice(0, MAX_NOTIFIED_GUESTS)) {
				if (input.allowGuestMail && !(await input.allowGuestMail())) break;
				guests.push(guest);
			}
			if (guests.length < input.guestEmails.length) console.warn("Booking confirmation: not every added guest was emailed", { eventId: input.event.id, added: input.guestEmails.length, emailed: guests.length });
			if (guests.length) await send(guests, false);
		}
		return true;
	} catch (error) {
		console.error("Booking confirmation failed", { eventId: input.event.id, error });
		return false;
	}
}
