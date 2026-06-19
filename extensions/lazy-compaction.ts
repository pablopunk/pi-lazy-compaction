import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm, estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";

const DEFAULT_THRESHOLD_PERCENT = 80;
const STATUS_KEY = "lazy-compaction";
const SUMMARY_MAX_TOKENS = 8192;
const SETTINGS_KEY = "lazyCompaction";

const SENTINEL_FIRST_KEPT_ID = "__lazy_compaction_no_entries_after_boundary__";

type LazyCompactionJob = {
	id: number;
	boundaryLeafId: string;
	startedAt: number;
	triggerPercent?: number;
	triggerTokens?: number;
	controller: AbortController;
};

type LazyCompactionSettings = {
	enabled: boolean;
	thresholdPercent: number;
	summarizer?: { provider: string; model: string };
};

type AppendableSessionManager = ExtensionContext["sessionManager"] & {
	appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean): string;
};

function formatPercent(value: number | undefined): string {
	return value === undefined || Number.isNaN(value) ? "?" : `${value.toFixed(1)}%`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8"));
}

function parseSummarizer(value: unknown): { provider: string; model: string } | undefined {
	if (typeof value === "string") {
		const slashIndex = value.indexOf("/");
		if (slashIndex > 0 && slashIndex < value.length - 1) {
			return { provider: value.slice(0, slashIndex), model: value.slice(slashIndex + 1) };
		}
	}
	if (isRecord(value) && typeof value.provider === "string" && typeof value.model === "string") {
		return { provider: value.provider, model: value.model };
	}
	return undefined;
}

function applySettings(base: LazyCompactionSettings, raw: unknown): LazyCompactionSettings {
	if (!isRecord(raw) || !(SETTINGS_KEY in raw)) return base;

	const value = raw[SETTINGS_KEY];
	if (typeof value === "boolean") return { ...base, enabled: value };
	if (!isRecord(value)) return base;

	const next = { ...base, summarizer: base.summarizer ? { ...base.summarizer } : undefined };
	if (typeof value.enabled === "boolean") next.enabled = value.enabled;
	if (typeof value.thresholdPercent === "number" && value.thresholdPercent > 0 && value.thresholdPercent < 100) {
		next.thresholdPercent = value.thresholdPercent;
	}

	const summarizer = parseSummarizer(value.summarizer);
	if (summarizer) next.summarizer = summarizer;
	return next;
}

function loadSettings(ctx: ExtensionContext): LazyCompactionSettings {
	let settings: LazyCompactionSettings = {
		enabled: false,
		thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
	};

	try {
		settings = applySettings(settings, readJson(join(process.env.HOME ?? "", ".pi/agent/settings.json")));
	} catch (error) {
		notify(ctx, `Could not read global ${SETTINGS_KEY} settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	if (ctx.isProjectTrusted()) {
		try {
			settings = applySettings(settings, readJson(join(ctx.cwd, ".pi/settings.json")));
		} catch (error) {
			notify(ctx, `Could not read project ${SETTINGS_KEY} settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	return settings;
}

function estimateMessagesTokens(messages: Parameters<typeof estimateTokens>[0][]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function getSessionContextUsage(ctx: ExtensionContext): { tokens: number; contextWindow: number; percent: number } | undefined {
	const contextWindow = ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const messages = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
	const tokens = estimateMessagesTokens(messages);
	return {
		tokens,
		contextWindow,
		percent: (tokens / contextWindow) * 100,
	};
}

function extractText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

export default function lazyCompaction(pi: ExtensionAPI) {
	let settings: LazyCompactionSettings = {
		enabled: false,
		thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
	};
	let job: LazyCompactionJob | null = null;
	let nextJobId = 1;
	let lastTriggeredLeafId: string | null = null;
	let latestAppliedCompactionEntryId: string | null = null;

	function setStatus(ctx: ExtensionContext, text?: string) {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
	}

	function finishJob(ctx: ExtensionContext, activeJob: LazyCompactionJob) {
		if (job?.id !== activeJob.id) return;
		job = null;
		setStatus(ctx, undefined);
	}

	async function chooseSummarizer(ctx: ExtensionContext) {
		const configuredSummarizer = settings.summarizer
			? ctx.modelRegistry.find(settings.summarizer.provider, settings.summarizer.model)
			: undefined;
		const candidates = [configuredSummarizer, ctx.model].filter(
			(model, index, models) => model && models.findIndex((m) => m?.provider === model.provider && m?.id === model.id) === index,
		);

		for (const model of candidates) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) return { model, auth };
		}

		return undefined;
	}

	async function runLazyCompaction(ctx: ExtensionContext, activeJob: LazyCompactionJob) {
		try {
			// Yield before doing any potentially expensive serialization so the TUI can
			// return to the editor immediately after agent_end.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (activeJob.controller.signal.aborted) return;

			const branchAtStart = ctx.sessionManager.getBranch(activeJob.boundaryLeafId);
			if (!branchAtStart.some((entry) => entry.id === activeJob.boundaryLeafId)) {
				notify(ctx, "Lazy compaction boundary is no longer on this branch; cancelling", "warning");
				return;
			}

			const contextAtBoundary = buildSessionContext(branchAtStart, activeJob.boundaryLeafId).messages;
			const conversationText = serializeConversation(convertToLlm(contextAtBoundary));
			const tokensBefore = activeJob.triggerTokens ?? estimateMessagesTokens(contextAtBoundary);

			const selected = await chooseSummarizer(ctx);
			if (!selected) {
				notify(ctx, "No authenticated model available for lazy compaction", "error");
				return;
			}

			const { model, auth } = selected;
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `You are lazily compacting an interactive coding-agent session in the background.

Create a high-signal summary of ALL context below. This summary will replace everything up to a pinned boundary. Any messages created after the boundary will be preserved verbatim after your summary, so do not invent future events.

The summary must preserve enough detail for the agent to continue without losing state:
- user goals, constraints, preferences, and decisions
- files read/modified and important code details
- commands run, validation results, failures, and fixes
- current plan, next steps, blockers, and risks
- any exact values, paths, identifiers, or snippets needed later

Use concise structured Markdown with these sections:
## Goal
## Constraints & Preferences
## Progress
## Key Decisions
## Files & Commands
## Current State / Next Steps
## Critical Context

<context-through-pinned-boundary>
${conversationText}
</context-through-pinned-boundary>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: SUMMARY_MAX_TOKENS,
					signal: activeJob.controller.signal,
				},
			);

			if (activeJob.controller.signal.aborted) return;

			const summary = extractText(response);
			if (!summary) {
				notify(ctx, "Lazy compaction produced an empty summary", "error");
				return;
			}

			// While the summary was running, the user may have added N+y messages.
			// Pick the first current-branch entry after the pinned boundary so pi keeps
			// that suffix in full: summary + FULL_MESSAGES_AFTER_N.
			const currentBranch = ctx.sessionManager.getBranch();
			const currentBoundaryIdx = currentBranch.findIndex((entry) => entry.id === activeJob.boundaryLeafId);
			if (currentBoundaryIdx === -1) {
				notify(ctx, "Lazy compaction branch changed while summarizing; cancelling", "warning");
				return;
			}

			const firstAfterBoundary = currentBranch[currentBoundaryIdx + 1];
			const firstKeptEntryId = firstAfterBoundary?.id ?? SENTINEL_FIRST_KEPT_ID;

			latestAppliedCompactionEntryId = (ctx.sessionManager as AppendableSessionManager).appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				{
					kind: "lazy-compaction",
					boundaryLeafId: activeJob.boundaryLeafId,
					firstKeptEntryId,
					startedAt: new Date(activeJob.startedAt).toISOString(),
					completedAt: new Date().toISOString(),
					triggerPercent: activeJob.triggerPercent,
					thresholdPercent: settings.thresholdPercent,
					summarizer: `${model.provider}/${model.id}`,
				},
				true,
			);

			notify(ctx, "Lazy compaction applied", "info");
		} catch (error) {
			if (!isAbortError(error)) {
				notify(ctx, `Lazy compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} finally {
			finishJob(ctx, activeJob);
		}
	}

	function startLazyCompaction(ctx: ExtensionContext) {
		if (!settings.enabled) return;
		if (job) return;

		const boundaryLeafId = ctx.sessionManager.getLeafId();
		if (!boundaryLeafId) return;
		if (lastTriggeredLeafId === boundaryLeafId) return;

		const usage = getSessionContextUsage(ctx);
		job = {
			id: nextJobId++,
			boundaryLeafId,
			startedAt: Date.now(),
			triggerPercent: usage?.percent ?? undefined,
			triggerTokens: usage?.tokens ?? undefined,
			controller: new AbortController(),
		};
		lastTriggeredLeafId = boundaryLeafId;

		setStatus(ctx, "compacting in the background...");
		void runLazyCompaction(ctx, job);
	}

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(ctx);
		job = null;
		lastTriggeredLeafId = null;
		latestAppliedCompactionEntryId = null;
		setStatus(ctx, undefined);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!settings.enabled || job) return;

		const usage = getSessionContextUsage(ctx);
		const percent = usage?.percent;
		if (percent === undefined || percent === null) return;
		if (percent < settings.thresholdPercent) return;

		startLazyCompaction(ctx);
	});

	pi.on("context", (_event, ctx) => {
		if (!latestAppliedCompactionEntryId) return;
		const branch = ctx.sessionManager.getBranch();
		if (!branch.some((entry) => entry.id === latestAppliedCompactionEntryId)) return;

		return {
			messages: buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		};
	});

	pi.on("session_shutdown", (_event, ctx) => {
		job?.controller.abort();
		job = null;
		setStatus(ctx, undefined);
	});
}
