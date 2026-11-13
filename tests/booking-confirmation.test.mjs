import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-booking-confirmation-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { c: join(root, "src/lib/booking/confirmation-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const {
	buildBookingCalendarFile, buildBookingConfirmation, formatBookingWhen, neutralizeBookerText, parseConfirmationTemplateInput, pickGuestLocale, renderBookingTemplate,
	DEFAULT_CONFIRMATION_SUBJECT, DEFAULT_CONFIRMATION_BODY, MAX_NOTES_IN_MAIL,
} = await import(pathToFileURL(join(dir, "c.mjs")).href);

const startsAt = new Date("2026-11-17T13:00:00Z");
const endsAt = new Date("2026-11-17T13:30:00Z");
const content = { eventName: "Intro call", hostName: "Paul", guestName: "Ana", location: "", notes: "", startsAt, endsAt, timeZone: "Europe/Berlin" };

test("formats the slot in the event's time zone, worded for the guest's locale", () => {
	assert.match(formatBookingWhen(startsAt, endsAt, "Europe/Berlin"), /^Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\)$/);
	// German only to check that {when} follows the guest's locale.
	assert.match(formatBookingWhen(startsAt, endsAt, "Europe/Berlin", "de"), /^Dienstag, 17\. November 2026, 14:00–14:30 \(Europe\/Berlin\)$/);
});

test("falls back to UTC for an unknown time zone", () => {
	assert.match(formatBookingWhen(startsAt, endsAt, "Not/AZone"), /13:00–13:30 \(UTC\)$/);
});

test("picks the booking page language, then the browser's, then English", () => {
	assert.equal(pickGuestLocale("de", "en-US,en;q=0.9"), "de");
	assert.equal(pickGuestLocale(null, "fr-FR,de;q=0.8"), "fr-FR");
	assert.equal(pickGuestLocale("not a tag!", "*"), "en-GB");
	assert.equal(pickGuestLocale(undefined, undefined), "en-GB");
});

test("without a template the default English text is sent, dropping an empty location and notes", () => {
	const mail = buildBookingConfirmation(content);
	assert.equal(mail.subject, "Confirmed: Intro call with Paul");
	assert.match(mail.text, /^Hi Ana,\n\nyour booking is confirmed: Intro call with Paul\.\n\nWhen: Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\)\n\nThe attached calendar file/);
	assert.doesNotMatch(mail.text, /Where:|Notes:|\{/);
	const full = buildBookingConfirmation({ ...content, location: "https://meet.example/abc", notes: "About pricing" });
	assert.match(full.text, /\nWhere: https:\/\/meet\.example\/abc\nNotes: About pricing\n/);
});

test("the default template only uses placeholders the editor offers", () => {
	const names = [...`${DEFAULT_CONFIRMATION_SUBJECT}\n${DEFAULT_CONFIRMATION_BODY}`.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(names)].sort(), ["eventName", "guestName", "hostName", "location", "notes", "when"]);
});

test("a template fills known placeholders, leaves others as written and drops lines left empty", () => {
	const values = { guestName: "Ana", eventName: "Consultation", hostName: "Paul", when: "tomorrow", location: "", notes: "" };
	assert.equal(renderBookingTemplate("Hello {guestName}, {eventName} {when} {unknown}.\nPlace: {location}\nNote: {notes} / {location}\nSee you", values), "Hello Ana, Consultation tomorrow {unknown}.\nSee you");
});

test("text typed on the booking page loses links, addresses and hidden characters", () => {
	const notes = neutralizeBookerText("Win a prize at https://evil.example/claim or www.evil.example.\nMail claims@evil.example, or visit evil.example/x?y=1.\n\n\n\nThanks‮!", { maxLength: 500 });
	assert.equal(notes, "Win a prize at [link removed] or [link removed]\nMail [address removed] or visit [link removed]\n\nThanks!");
	assert.equal(neutralizeBookerText("Ana\n\tSmith", { singleLine: true, maxLength: 120 }), "Ana Smith");
	assert.equal(neutralizeBookerText("Version 2.0, e.g. a draft", { maxLength: 500 }), "Version 2.0, e.g. a draft");
	const long = neutralizeBookerText("x".repeat(600), { maxLength: MAX_NOTES_IN_MAIL });
	assert.equal(long.length, MAX_NOTES_IN_MAIL);
	assert.ok(long.endsWith("…"));
});

test("the booker's name and notes reach the mail neutralized, and the guests' copy has no notes", () => {
	const booking = { ...content, guestName: "Ana\nBcc: x@evil.example", notes: "Agenda: pricing. Details at https://evil.example" };
	const booker = buildBookingConfirmation(booking);
	assert.match(booker.text, /^Hi Ana Bcc: \[address removed\],\n/);
	assert.match(booker.text, /\nNotes: Agenda: pricing\. Details at \[link removed\]\n/);
	assert.doesNotMatch(booker.text, /evil\.example/);
	const guests = buildBookingConfirmation(booking, undefined, null, { includeNotes: false });
	assert.doesNotMatch(guests.text, /Notes:|Agenda/);
	const custom = buildBookingConfirmation(booking, undefined, { subject: "", body: "Notes: {notes}" }, { includeNotes: false });
	assert.equal(custom.text, "");
});

test("the event's subject and body replace the default, each on its own", () => {
	const booking = { ...content, eventName: "Consultation", location: "Phone", notes: "Pricing" };
	const custom = buildBookingConfirmation(booking, "en-GB", { subject: "Meeting on {when} for {guestName}", body: "Hello {guestName},\nsee you {when} ({location}).\n{notes}" });
	assert.match(custom.subject, /^Meeting on Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\) for Ana$/);
	assert.match(custom.text, /^Hello Ana,\nsee you Tuesday,? 17 November 2026, 14:00–14:30 \(Europe\/Berlin\) \(Phone\)\.\nPricing$/);
	const subjectOnly = buildBookingConfirmation(booking, "en-GB", { subject: "Your meeting", body: "" });
	assert.equal(subjectOnly.subject, "Your meeting");
	assert.match(subjectOnly.text, /^Hi Ana/);
	const bodyOnly = buildBookingConfirmation(booking, "en-GB", { subject: "", body: "Thank you!" });
	assert.equal(bodyOnly.subject, "Confirmed: Consultation with Paul");
	assert.equal(bodyOnly.text, "Thank you!");
	assert.equal(buildBookingConfirmation(booking, "en-GB", { subject: "{notes}", body: "" }).subject, "Pricing");
	assert.equal(buildBookingConfirmation({ ...booking, notes: "" }, "en-GB", { subject: "{notes}", body: "" }).subject, "Confirmed: Consultation with Paul");
});

test("confirmation fields in a booking event request are optional, trimmed and bounded", () => {
	assert.equal(parseConfirmationTemplateInput({ name: "x" }), undefined);
	assert.equal(parseConfirmationTemplateInput(null), undefined);
	assert.deepEqual(parseConfirmationTemplateInput({ confirmationSubject: " Hi\r\nthere ", confirmationBody: " a\r\nb " }), { subject: "Hi there", body: "a\nb", notifyGuests: false });
	assert.deepEqual(parseConfirmationTemplateInput({ confirmationBody: "only body" }), { subject: "", body: "only body", notifyGuests: false });
	assert.deepEqual(parseConfirmationTemplateInput({ confirmationNotifyGuests: true }), { subject: "", body: "", notifyGuests: true });
	assert.equal(parseConfirmationTemplateInput({ confirmationNotifyGuests: "yes" }), null);
	assert.equal(parseConfirmationTemplateInput({ confirmationSubject: 5 }), null);
	assert.equal(parseConfirmationTemplateInput({ confirmationSubject: "x".repeat(201) }), null);
	assert.equal(parseConfirmationTemplateInput({ confirmationBody: "x".repeat(5001) }), null);
});

test("the calendar file is a plain event to add, not a meeting request", () => {
	const ics = new TextDecoder().decode(buildBookingCalendarFile({ title: "Consultation (Paul)", description: "Hello", location: "Phone", startsAt, endsAt, uid: "bkg_1" }));
	assert.match(ics, /\r\nMETHOD:PUBLISH\r\n/);
	assert.match(ics, /\r\nDTSTART:20261117T130000Z\r\nDTEND:20261117T133000Z\r\n/);
	assert.doesNotMatch(ics, /ORGANIZER|ATTENDEE|RSVP/);
});
