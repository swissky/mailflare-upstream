import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders, users } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/types";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getImportMessageUserId, parseImportDestination } from "./destination";
import { fetchImapMessages } from "./imap";
import { importMessagesToMailbox } from "./service";
import type {
	ImapConnectionInput,
	ImapImportJob,
	ImapImportJobMessage,
	ImapImportJobStep,
} from "./imap-job-types";

const MAX_ATTEMPTS = 3;
const MAX_STORED_ERRORS = 50;
/** A running job whose state has not changed for this long lost its queue message. */
const STALLED_AFTER_MS = 15 * 60_000;

export type ImapImportJobView = ImapImportJob & { cancelRequested: boolean; stalled: boolean };

export class ImapImportJobError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

function jobKey(id: string): string {
	return `import-jobs/${id}.json`;
}

function cancelKey(id: string): string {
	return `import-jobs/${id}.cancel`;
}

function getImportQueue(env: CloudflareEnv) {
	return env.AGENT_QUEUE ?? null;
}

export function isImapImportJobAvailable(env: CloudflareEnv): boolean {
	return getImportQueue(env) !== null;
}

export function isImapImportJobMessage(body: unknown): body is ImapImportJobMessage {
	if (typeof body !== "object" || body === null) return false;
	const value = body as Partial<ImapImportJobMessage>;
	return value.kind === "import.imap" && typeof value.jobId === "string" && typeof value.cursor === "number";
}

async function readJob(env: CloudflareEnv, id: string): Promise<ImapImportJob | null> {
	const object = await env.BUCKET.get(jobKey(id));
	return object ? object.json<ImapImportJob>() : null;
}

async function saveJob(env: CloudflareEnv, job: ImapImportJob): Promise<ImapImportJob> {
	const saved = { ...job, updatedAt: new Date().toISOString() };
	await env.BUCKET.put(jobKey(job.id), JSON.stringify(saved), {
		httpMetadata: { contentType: "application/json" },
	});
	return saved;
}

async function enqueue(env: CloudflareEnv, message: ImapImportJobMessage, delaySeconds = 0): Promise<void> {
	const queue = getImportQueue(env);
	if (!queue) throw new ImapImportJobError("Background import needs the mailflare-agent queue", 501);
	await queue.send(message, delaySeconds ? { delaySeconds } : undefined);
}

async function toView(env: CloudflareEnv, job: ImapImportJob): Promise<ImapImportJobView> {
	const cancelRequested = job.status === "running" && !!(await env.BUCKET.head(cancelKey(job.id)));
	const stalled = job.status === "running" && Date.now() - Date.parse(job.updatedAt) > STALLED_AFTER_MS;
	return { ...job, cancelRequested, stalled };
}

async function getOwnedJob(env: CloudflareEnv, id: string, userId: string): Promise<ImapImportJob> {
	const job = await readJob(env, id);
	if (!job || job.userId !== userId) throw new ImapImportJobError("Import job not found", 404);
	return job;
}

export async function createImapImportJob(
	env: CloudflareEnv,
	input: {
		user: Pick<SessionUser, "id" | "role">;
		mailboxId: string;
		connection: ImapConnectionInput;
		steps: Pick<ImapImportJobStep, "folder" | "destination" | "label">[];
		limit: number;
		importAll: boolean;
	},
): Promise<ImapImportJobView> {
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, input.user, input.mailboxId);
	if (!access?.canManage) throw new ImapImportJobError("Mailbox not found", 404);

	const folderIds = input.steps.flatMap((step) => {
		const destination = parseImportDestination(step.destination);
		return destination.type === "folder" ? [destination.folderId] : [];
	});
	if (folderIds.length > 0) {
		const unique = [...new Set(folderIds)];
		const found = await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.mailboxId, access.mailbox.id), inArray(folders.id, unique)));
		if (found.length !== unique.length) throw new ImapImportJobError("Folder not found", 404);
	}

	const now = new Date().toISOString();
	const job = await saveJob(env, {
		id: newId("ijob"),
		userId: input.user.id,
		mailboxId: access.mailbox.id,
		status: "running",
		steps: input.steps.map((step) => ({ ...step, total: null, processed: 0 })),
		stepIndex: 0,
		offset: 0,
		cursor: 0,
		limit: input.limit,
		importAll: input.importAll,
		attempts: 0,
		imported: 0,
		skipped: 0,
		errors: [],
		error: null,
		createdAt: now,
		updatedAt: now,
	});
	await enqueue(env, { kind: "import.imap", jobId: job.id, cursor: job.cursor, connection: input.connection });
	return toView(env, job);
}

export async function getImapImportJob(env: CloudflareEnv, id: string, userId: string): Promise<ImapImportJobView> {
	return toView(env, await getOwnedJob(env, id, userId));
}

export async function cancelImapImportJob(env: CloudflareEnv, id: string, userId: string): Promise<ImapImportJobView> {
	const job = await getOwnedJob(env, id, userId);
	if (job.status !== "running") return toView(env, job);
	// A stalled job has no queue message left to observe the marker, so it is closed here.
	if (Date.now() - Date.parse(job.updatedAt) > STALLED_AFTER_MS) {
		return toView(env, await saveJob(env, { ...job, status: "cancelled" }));
	}
	await env.BUCKET.put(cancelKey(id), "1");
	return toView(env, job);
}

/** Restarts a failed or stalled job from its last completed batch. */
export async function resumeImapImportJob(
	env: CloudflareEnv,
	id: string,
	userId: string,
	connection: ImapConnectionInput,
): Promise<ImapImportJobView> {
	const job = await getOwnedJob(env, id, userId);
	const view = await toView(env, job);
	if (job.status !== "failed" && !view.stalled) throw new ImapImportJobError("Import job is not resumable", 409);
	const resumed = await saveJob(env, { ...job, status: "running", attempts: 0, error: null, cursor: job.cursor + 1 });
	await env.BUCKET.delete(cancelKey(id));
	await enqueue(env, { kind: "import.imap", jobId: id, cursor: resumed.cursor, connection });
	return toView(env, resumed);
}

function isPermanentImapError(message: string): boolean {
	return /AUTHENTICATIONFAILED|Invalid credentials|not allowed|IMAP host is required|Unknown Mailbox|NONEXISTENT/i.test(message);
}

export async function processImapImportJob(env: CloudflareEnv, message: ImapImportJobMessage): Promise<void> {
	const job = await readJob(env, message.jobId);
	if (!job || job.status !== "running" || job.cursor !== message.cursor) return;

	if (await env.BUCKET.head(cancelKey(job.id))) {
		await saveJob(env, { ...job, status: "cancelled" });
		await env.BUCKET.delete(cancelKey(job.id));
		return;
	}

	const db = getDb(env);
	const [user] = await db
		.select({ id: users.id, role: users.role, disabled: users.disabled })
		.from(users)
		.where(eq(users.id, job.userId))
		.limit(1);
	const access = user && !user.disabled ? await getMailboxAccessLevel(db, user, job.mailboxId) : null;
	if (!user || !access?.canManage) {
		await saveJob(env, { ...job, status: "failed", error: "Mailbox access was revoked" });
		return;
	}

	const step = job.steps[job.stepIndex];
	if (!step) {
		await saveJob(env, { ...job, status: "completed" });
		return;
	}

	let fetched: Awaited<ReturnType<typeof fetchImapMessages>>;
	let result: Awaited<ReturnType<typeof importMessagesToMailbox>>;
	try {
		const destination = parseImportDestination(step.destination);
		fetched = await fetchImapMessages({ ...message.connection, folder: step.folder, limit: job.limit, offset: job.offset });
		result = await importMessagesToMailbox(env, {
			userId: getImportMessageUserId(destination, user.id, access.mailbox.userId),
			mailboxId: access.mailbox.id,
			destination,
			messages: fetched.messages,
		});
	} catch (error) {
		const reason = `${step.label}: ${error instanceof Error ? error.message : "IMAP import failed"}`.slice(0, 500);
		const attempts = job.attempts + 1;
		if (attempts >= MAX_ATTEMPTS || isPermanentImapError(reason)) {
			await saveJob(env, { ...job, attempts, status: "failed", error: reason });
			return;
		}
		const retry = await saveJob(env, { ...job, attempts, cursor: job.cursor + 1, error: reason });
		await enqueue(env, { ...message, cursor: retry.cursor }, 30 * attempts);
		return;
	}

	const steps = job.steps.map((item, index) =>
		index === job.stepIndex
			? { ...item, total: fetched.total, processed: item.processed + fetched.messages.length }
			: item,
	);
	const moreInStep = job.importAll && fetched.nextOffset !== null && fetched.nextOffset > job.offset;
	const stepIndex = moreInStep ? job.stepIndex : job.stepIndex + 1;
	const completed = stepIndex >= steps.length;
	const next = await saveJob(env, {
		...job,
		steps,
		stepIndex,
		offset: moreInStep ? (fetched.nextOffset ?? 0) : 0,
		cursor: job.cursor + 1,
		attempts: 0,
		error: null,
		status: completed ? "completed" : "running",
		imported: job.imported + result.imported,
		skipped: job.skipped + result.skipped,
		errors: [...job.errors, ...result.errors].slice(-MAX_STORED_ERRORS),
	});
	if (!completed) await enqueue(env, { ...message, cursor: next.cursor });
}
