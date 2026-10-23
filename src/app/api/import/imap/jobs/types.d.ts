import type { ImapImportRequest } from "../types";

export type ImapImportJobRequest = Omit<ImapImportRequest, "folder" | "offset" | "destination"> & {
	importAll?: boolean;
	steps?: { folder?: string; destination?: string; label?: string }[];
};
