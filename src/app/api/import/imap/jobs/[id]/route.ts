import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { readJsonBody } from "@/lib/http/request";
import { cancelImapImportJob, getImapImportJob, resumeImapImportJob } from "@/lib/import/imap-jobs";
import { parseImapConnection } from "../../utils";
import type { ImapImportJobRequest } from "../types";
import { imapImportJobErrorResponse } from "../utils";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
	const env = getEnv();
	const user = await requireUser(env, request);
	try {
		const { id } = await params;
		return NextResponse.json({ job: await getImapImportJob(env, id, user.id) });
	} catch (error) {
		return imapImportJobErrorResponse(error);
	}
}

/** Resumes a failed or stalled job. The source password is sent again because jobs never store it. */
export async function POST(request: Request, { params }: RouteContext) {
	const env = getEnv();
	const user = await requireUser(env, request);
	try {
		const { id } = await params;
		const connection = parseImapConnection(await readJsonBody<ImapImportJobRequest>(request, 16 * 1024));
		return NextResponse.json({ job: await resumeImapImportJob(env, id, user.id, connection) });
	} catch (error) {
		return imapImportJobErrorResponse(error);
	}
}

export async function DELETE(request: Request, { params }: RouteContext) {
	const env = getEnv();
	const user = await requireUser(env, request);
	try {
		const { id } = await params;
		return NextResponse.json({ job: await cancelImapImportJob(env, id, user.id) });
	} catch (error) {
		return imapImportJobErrorResponse(error);
	}
}
