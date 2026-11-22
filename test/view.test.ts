// Task listing: counting, filtering and paging translate only the tasks a page returns.
import { TaskState } from "@a2a-js/sdk";
import type { ConversationId, Cursor, Page, TaskQuery, TaskRecord, Tx } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { listTasks, type TaskListing } from "../src/view.ts";

type AnyRecord = TaskRecord<unknown, unknown, unknown>;
const conversationId = 1 as ConversationId;
const listing = (overrides: Partial<TaskListing>): TaskListing => ({
	pageSize: 1,
	pageToken: "",
	status: TaskState.TASK_STATE_UNSPECIFIED,
	after: undefined,
	...overrides,
});

/** A scan over `records` by offset, reporting each call. */
function scanning(
	records: (offset: number, limit: number) => AnyRecord[],
	count: number,
	onScan: (limit: number, offset: number) => void = () => {},
): Pick<Tx, "scanTasks"> {
	return {
		async scanTasks(_query: TaskQuery, limit: number, cursor?: Cursor) {
			const offset = (cursor?.offset as number | undefined) ?? 0;
			onScan(limit, offset);
			const next = Math.min(count, offset + limit);
			const page: Page<AnyRecord, Cursor> = {
				items: records(offset, next),
				next: next < count ? { offset: next } : undefined,
			};
			// Fixture records stand in for stored ones; the listing reads them as stored JSON.
			return page as Awaited<ReturnType<Tx["scanTasks"]>>;
		},
	};
}

// A working record whose task view can be built.
const working = (id: number) =>
	({
		id,
		version: 1,
		kind: "a2a.task",
		conversationId,
		startedAt: 3000,
		input: { messageId: `working-${id}`, text: "Small input", acceptedAt: 3000 },
		state: { status: "sleeping" },
	}) as unknown as AnyRecord;

// A completed record whose answer must never be read: counting and filtering use only state and timestamps.
const untranslatable = (id: number) =>
	({
		id,
		version: 1,
		kind: "a2a.task",
		conversationId,
		startedAt: 1000,
		endedAt: 2000,
		get input() {
			throw new Error("An unreturned task must not be translated");
		},
		state: {
			status: "terminal",
			outcome: {
				status: "completed",
				get result() {
					throw new Error("An unreturned answer must not be translated");
				},
			},
		},
	}) as unknown as AnyRecord;

describe("listTasks", () => {
	test("counts and filters without translating unreturned tasks", async () => {
		const records = [working(3), untranslatable(2), untranslatable(1)];
		const tx = scanning((from, to) => records.slice(from, to), records.length);
		const all = await listTasks(tx, conversationId, listing({}));
		expect(all.totalSize).toBe(3);
		expect(all.tasks.map((task) => task.id)).toEqual(["3"]);
		expect(all.nextPageToken).toBeTruthy();
		const active = await listTasks(tx, conversationId, listing({ status: TaskState.TASK_STATE_WORKING }));
		expect(active).toMatchObject({ totalSize: 1, nextPageToken: "" });
		expect(active.tasks.map((task) => task.id)).toEqual(["3"]);
		const recent = await listTasks(tx, conversationId, listing({ after: 2500 }));
		expect(recent.totalSize).toBe(1);
		expect(recent.tasks.map((task) => task.id)).toEqual(["3"]);
	});

	test("zero matches stop after the batched count", async () => {
		const count = 10_000;
		let scans = 0;
		const tx = scanning(
			(from, to) => Array.from({ length: to - from }, () => untranslatable(1)),
			count,
			(limit) => {
				scans += 1;
				expect(limit).toBe(100);
			},
		);
		const page = await listTasks(tx, conversationId, listing({ status: TaskState.TASK_STATE_WORKING }));
		expect(page).toEqual({ tasks: [], nextPageToken: "", totalSize: 0 });
		expect(scans).toBe(count / 100);
	});

	test("a first page holding every match needs no lookahead", async () => {
		const count = 10_000;
		let countScans = 0;
		let pageScans = 0;
		const tx = scanning(
			(from, to) =>
				Array.from({ length: to - from }, (_, index) => (from + index === 0 ? working(count) : untranslatable(1))),
			count,
			(limit, offset) => {
				if (limit === 100) countScans += 1;
				else {
					pageScans += 1;
					expect(offset).toBe(0);
				}
			},
		);
		const page = await listTasks(tx, conversationId, listing({ status: TaskState.TASK_STATE_WORKING }));
		expect(page.tasks.map((task) => task.id)).toEqual([String(count)]);
		expect(page).toMatchObject({ totalSize: 1, nextPageToken: "" });
		expect(countScans).toBe(count / 100);
		expect(pageScans).toBe(1);
	});
});
