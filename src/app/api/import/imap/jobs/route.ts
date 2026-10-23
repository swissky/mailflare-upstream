import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { createImapImportJob, isImapImportJobAvailable } from "@/lib/import/imap-jobs";
import type { ImapImportJobRequest } from "./types";
import { imapImportJobErrorResponse, parseImapImportJobRequest } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!isImapImportJobAvailable(env)) {
		return NextResponse.json({ error: "Background import is not available" }, { status: 501 });
	}

	let input: ReturnType<typeof parseImapImportJobRequest>;
	try {
		input = parseImapImportJobRequest(await readJsonBody<ImapImportJobRequest>(request, 64 * 1024));
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid IMAP import request" }, { status });
	}

	try {
		const job = await createImapImportJob(env, { user, ...input });
		return NextResponse.json({ job }, { status: 202 });
	} catch (error) {
		return imapImportJobErrorResponse(error);
	}
}
