import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-imap-jobs-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The job runner is tested on its own: storage, queue, database, IMAP and the
// import service are replaced so only the batch/step state machine runs.
const stubs = {
	"drizzle-orm": "export const and = () => null; export const eq = () => null; export const inArray = () => null;",
	"@/db": `
		function query(table) {
			const chain = {
				from: (next) => query(next),
				where: () => chain,
				limit: () => chain,
				then: (resolve, reject) => Promise.resolve(globalThis.__rows(table)).then(resolve, reject),
			};
			return chain;
		}
		export const getDb = () => ({ select: () => query(null) });`,
	"@/db/schema": 'export const users = { table: "users" }; export const folders = { table: "folders" };',
	"@/lib/ids": "let next = 0; export const newId = (prefix) => `${prefix}_${++next}`;",
	"@/lib/mailboxes/access": "export const getMailboxAccessLevel = async (db, user, mailboxId) => globalThis.__access(user, mailboxId);",
	"./imap": "export const fetchImapMessages = (input) => globalThis.__fetch(input);",
	"./service": "export const importMessagesToMailbox = (env, input) => globalThis.__import(input);",
};

await build({
	stdin: {
		contents: `export * from "./src/lib/import/imap-jobs.ts";`,
		resolveDir: root,
		sourcefile: "imap-jobs-test-entry.js",
	},
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	plugins: [
		{
			name: "stubs",
			setup(pluginBuild) {
				const filter = new RegExp(`^(${Object.keys(stubs).map((key) => key.replace(/[./@-]/g, "\\$&")).join("|")})$`);
				pluginBuild.onResolve({ filter }, (args) => ({ path: args.path, namespace: "stub" }));
				pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
			},
		},
	],
});

const jobs = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

const connection = { host: "imap.example.com", port: 993, secure: true, username: "me@example.com", password: "app-password" };
const user = { id: "usr_1", role: "admin" };

let objects;
let sent;
let fetchCalls;
let folderSizes;
let failures;

function makeEnv() {
	return {
		BUCKET: {
			async get(key) {
				return objects.has(key) ? { json: async () => JSON.parse(objects.get(key)) } : null;
			},
			async head(key) {
				return objects.has(key) ? {} : null;
			},
			async put(key, value) {
				objects.set(key, String(value));
			},
			async delete(key) {
				objects.delete(key);
			},
		},
		AGENT_QUEUE: {
			async send(body, options) {
				sent.push({ body, delaySeconds: options?.delaySeconds ?? 0 });
			},
		},
	};
}

beforeEach(() => {
	objects = new Map();
	sent = [];
	fetchCalls = [];
	failures = [];
	folderSizes = { INBOX: 250, "[Gmail]/Sent Mail": 30 };
	globalThis.__rows = (table) => (table?.table === "users" ? [{ ...user, disabled: false }] : []);
	globalThis.__access = async () => ({ canManage: true, mailbox: { id: "mbx_1", userId: user.id } });
	globalThis.__fetch = async (input) => {
		fetchCalls.push({ folder: input.folder, offset: input.offset, password: input.password });
		const failure = failures.shift();
		if (failure) throw new Error(failure);
		const total = folderSizes[input.folder];
		const count = Math.max(0, Math.min(input.limit, total - input.offset));
		const covered = input.offset + count;
		return {
			messages: Array.from({ length: count }, (_, index) => ({ filename: `${input.folder}-${covered - index}.eml` })),
			total,
			nextOffset: covered < total ? covered : null,
		};
	};
	globalThis.__import = async (input) => ({ imported: input.messages.length, skipped: 0, errors: [] });
});

const steps = [
	{ folder: "INBOX", destination: "system:inbox", label: "Inbox" },
	{ folder: "[Gmail]/Sent Mail", destination: "system:sent", label: "Sent" },
];

async function startJob(env, overrides = {}) {
	return jobs.createImapImportJob(env, { user, mailboxId: "mbx_1", connection, steps, limit: 100, importAll: true, ...overrides });
}

async function drain(env) {
	while (sent.length > 0) {
		const { body } = sent.shift();
		await jobs.processImapImportJob(env, body);
	}
}

test("a job walks every batch of every folder and then completes", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	await drain(env);

	const done = await jobs.getImapImportJob(env, job.id, user.id);
	assert.equal(done.status, "completed");
	assert.equal(done.imported, 280);
	assert.deepEqual(done.steps.map((step) => [step.processed, step.total]), [[250, 250], [30, 30]]);
	assert.deepEqual(fetchCalls.map((call) => `${call.folder}@${call.offset}`), ["INBOX@0", "INBOX@100", "INBOX@200", "[Gmail]/Sent Mail@0"]);
});

test("without importAll only the newest batch of each folder is imported", async () => {
	const env = makeEnv();
	const job = await startJob(env, { importAll: false });
	await drain(env);
	const done = await jobs.getImapImportJob(env, job.id, user.id);
	assert.equal(done.status, "completed");
	assert.equal(done.imported, 130);
});

test("the stored job never contains the IMAP password", async () => {
	const env = makeEnv();
	await startJob(env);
	await drain(env);
	for (const value of objects.values()) assert.ok(!value.includes(connection.password));
	assert.ok(fetchCalls.every((call) => call.password === connection.password));
});

test("a redelivered queue message for an older cursor is ignored", async () => {
	const env = makeEnv();
	await startJob(env);
	const first = sent.shift().body;
	await jobs.processImapImportJob(env, first);
	await jobs.processImapImportJob(env, first);
	assert.equal(fetchCalls.length, 1);
	assert.equal(sent.length, 1);
});

test("transient errors retry with a delay, then the job fails", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	failures = ["IMAP connection closed unexpectedly", "IMAP connection closed unexpectedly", "IMAP connection closed unexpectedly"];

	await jobs.processImapImportJob(env, sent.shift().body);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].delaySeconds, 30);
	await jobs.processImapImportJob(env, sent.shift().body);
	assert.equal(sent[0].delaySeconds, 60);
	await jobs.processImapImportJob(env, sent.shift().body);
	assert.equal(sent.length, 0);

	const failed = await jobs.getImapImportJob(env, job.id, user.id);
	assert.equal(failed.status, "failed");
	assert.match(failed.error, /Inbox: IMAP connection closed/);
});

test("a rejected login fails at once and can be resumed with a new password", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	failures = ["IMAP command failed: A0001 NO [AUTHENTICATIONFAILED] Invalid credentials"];
	await jobs.processImapImportJob(env, sent.shift().body);
	assert.equal(sent.length, 0);
	assert.equal((await jobs.getImapImportJob(env, job.id, user.id)).status, "failed");

	await jobs.resumeImapImportJob(env, job.id, user.id, { ...connection, password: "new-password" });
	await drain(env);
	const done = await jobs.getImapImportJob(env, job.id, user.id);
	assert.equal(done.status, "completed");
	assert.equal(fetchCalls.at(-1).password, "new-password");
});

test("cancelling stops the job before its next batch", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	await jobs.processImapImportJob(env, sent.shift().body);
	const cancelling = await jobs.cancelImapImportJob(env, job.id, user.id);
	assert.equal(cancelling.cancelRequested, true);

	await drain(env);
	const cancelled = await jobs.getImapImportJob(env, job.id, user.id);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(fetchCalls.length, 1);
});

test("other users cannot read or cancel a job", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	await assert.rejects(() => jobs.getImapImportJob(env, job.id, "usr_2"), /not found/);
	await assert.rejects(() => jobs.cancelImapImportJob(env, job.id, "usr_2"), /not found/);
});

test("losing mailbox access fails the job instead of importing", async () => {
	const env = makeEnv();
	const job = await startJob(env);
	globalThis.__access = async () => null;
	await jobs.processImapImportJob(env, sent.shift().body);
	assert.equal(fetchCalls.length, 0);
	assert.equal((await jobs.getImapImportJob(env, job.id, user.id)).error, "Mailbox access was revoked");
});
