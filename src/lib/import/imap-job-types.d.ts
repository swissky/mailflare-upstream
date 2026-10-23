export type ImapConnectionInput = {
	host: string;
	port: number;
	secure: boolean;
	username: string;
	password: string;
};

export type ImapImportJobStep = {
	/** Source folder on the IMAP server. */
	folder: string;
	/** Import destination string, e.g. `system:inbox` or `folder:<id>`. */
	destination: string;
	label: string;
	/** Messages in the source folder, known after its first batch. */
	total: number | null;
	processed: number;
};

export type ImapImportJobStatus = "running" | "completed" | "failed" | "cancelled";

export type ImapImportJob = {
	id: string;
	userId: string;
	mailboxId: string;
	status: ImapImportJobStatus;
	steps: ImapImportJobStep[];
	stepIndex: number;
	offset: number;
	/** Increases with every processed batch; queue messages for an older cursor are stale. */
	cursor: number;
	limit: number;
	importAll: boolean;
	attempts: number;
	imported: number;
	skipped: number;
	errors: string[];
	error: string | null;
	createdAt: string;
	updatedAt: string;
};

/** Credentials travel only inside the queue message; job state in storage never holds them. */
export type ImapImportJobMessage = {
	kind: "import.imap";
	jobId: string;
	cursor: number;
	connection: ImapConnectionInput;
};
