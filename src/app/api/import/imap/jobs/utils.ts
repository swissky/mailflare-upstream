import { NextResponse } from "next/server";
import { parseImportDestination } from "@/lib/import/destination";
import type { ImapImportJobStep } from "@/lib/import/imap-job-types";
import { ImapImportJobError } from "@/lib/import/imap-jobs";
import { parseImapBatchLimit, parseImapConnection } from "../utils";
import type { ImapImportJobRequest } from "./types";

const MAX_STEPS = 200;

export function parseImapImportJobRequest(input: ImapImportJobRequest) {
	if (!input.mailboxId) throw new Error("Mailbox is required");
	const steps = Array.isArray(input.steps) ? input.steps : [];
	if (steps.length === 0 || steps.length > MAX_STEPS) throw new Error("Select between 1 and 200 source folders");

	return {
		mailboxId: input.mailboxId,
		connection: parseImapConnection(input),
		limit: parseImapBatchLimit(input.limit),
		importAll: input.importAll !== false,
		steps: steps.map((step): Pick<ImapImportJobStep, "folder" | "destination" | "label"> => {
			const folder = step.folder?.trim() ?? "";
			if (!folder || folder.length > 500) throw new Error("IMAP folder is invalid");
			const destination = step.destination?.trim() || "system:inbox";
			parseImportDestination(destination);
			return { folder, destination, label: (step.label?.trim() || folder).slice(0, 200) };
		}),
	};
}

export function imapImportJobErrorResponse(error: unknown): NextResponse {
	if (error instanceof ImapImportJobError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	return NextResponse.json({ error: error instanceof Error ? error.message : "Import job failed" }, { status: 400 });
}
