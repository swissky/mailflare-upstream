import type { ImapImportInput } from "@/lib/import/imap-types";
import type { ImapConnectionInput } from "@/lib/import/imap-job-types";
import { parseImportDestination } from "@/lib/import/destination";
import type { ImportDestination } from "@/lib/import/destination-types";
import type { ImapImportRequest } from "./types";

export function parseImapConnection(input: Partial<ImapImportRequest>): ImapConnectionInput {
	const host = input.host?.trim() ?? "";
	const port = Number(input.port ?? 993);
	const username = input.username?.trim() ?? "";
	const password = input.password ?? "";

	if (!host) throw new Error("IMAP host is required");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IMAP port is invalid");
	if (!username || !password) throw new Error("IMAP username and password are required");

	return { host, port, secure: input.secure ?? port === 993, username, password };
}

export function parseImapBatchLimit(value: unknown): number {
	const limit = Number(value ?? 100);
	return Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 100) : 100;
}

export function parseImapImportRequest(input: ImapImportRequest): ImapImportInput & {
	mailboxId: string;
	destination: ImportDestination;
} {
	const folder = input.folder?.trim() || "INBOX";
	const offset = Math.max(Math.floor(Number(input.offset ?? 0)) || 0, 0);
	const destination = parseImportDestination(input.destination);

	if (!input.mailboxId) throw new Error("Mailbox is required");
	const connection = parseImapConnection(input);

	return {
		mailboxId: input.mailboxId,
		...connection,
		folder,
		limit: parseImapBatchLimit(input.limit),
		offset,
		destination,
	};
}
