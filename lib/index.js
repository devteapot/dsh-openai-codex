import { Service } from "@deepseek-ai/cordis";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { createModels, getSupportedThinkingLevels, isContextOverflow } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import "@deepseek-ai/dsh-user-questions";
//#region src/replay.ts
/**
* Durable pi-ai replay metadata and assistant-history reconstruction.
*
* Harness content remains the durable source for text and tool calls. This
* module stores only the provider-native metadata needed to reconstruct a
* pi-ai assistant message on a later request.
*
* @module @devteapot/dsh-openai-codex/replay
*/
/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
/**
* Project a successful pi-ai response into the minimal durable replay state.
* @param message - completed native pi-ai assistant response.
* @returns the versioned lossless-JSON replay projection.
*/
function toPiReplayState(message) {
	return {
		kind: "pi-ai",
		version: 1,
		api: message.api,
		provider: message.provider,
		model: message.model,
		...message.responseModel === void 0 ? {} : { responseModel: message.responseModel },
		...message.responseId === void 0 ? {} : { responseId: message.responseId },
		stopReason: message.stopReason,
		blocks: message.content.map((block) => {
			switch (block.type) {
				case "text": return {
					type: "text",
					...block.textSignature === void 0 ? {} : { textSignature: block.textSignature }
				};
				case "thinking": return {
					type: "reasoning",
					...block.thinkingSignature === void 0 ? {} : { thinkingSignature: block.thinkingSignature },
					...block.redacted === void 0 ? {} : { redacted: block.redacted }
				};
				case "toolCall": return {
					type: "tool-call",
					...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
				};
			}
		})
	};
}
function invalidReplay(message) {
	throw new LlmError(`invalid pi-ai replay state: ${message}`, "INVALID_REPLAY_STATE");
}
/** Validate the adapter-private state before it reaches pi-ai. */
function readReplayState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay("expected an object");
	const state = value;
	if (state["kind"] !== "pi-ai") return invalidReplay("unknown state kind");
	if (state["version"] !== 1) return invalidReplay(`unsupported version ${String(state["version"])}`);
	for (const key of [
		"api",
		"provider",
		"model"
	]) if (typeof state[key] !== "string" || state[key].length === 0) return invalidReplay(`${key} must be a non-empty string`);
	if (![
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted"
	].includes(String(state["stopReason"]))) return invalidReplay("unknown stopReason");
	if (state["responseModel"] !== void 0 && typeof state["responseModel"] !== "string") return invalidReplay("responseModel must be a string");
	if (state["responseId"] !== void 0 && typeof state["responseId"] !== "string") return invalidReplay("responseId must be a string");
	if (!Array.isArray(state["blocks"])) return invalidReplay("blocks must be an array");
	for (const [index, value] of state["blocks"].entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`);
		const block = value;
		if (![
			"text",
			"reasoning",
			"tool-call"
		].includes(String(block["type"]))) return invalidReplay(`block ${index} has an unknown type`);
		for (const signature of [
			"textSignature",
			"thinkingSignature",
			"thoughtSignature"
		]) if (block[signature] !== void 0 && typeof block[signature] !== "string") return invalidReplay(`block ${index} ${signature} must be a string`);
		if (block["redacted"] !== void 0 && typeof block["redacted"] !== "boolean") return invalidReplay(`block ${index} redacted must be boolean`);
	}
	return state;
}
/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message) {
	const source = message.source.kind === "model" ? message.source : void 0;
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		case "image": throw new LlmError("pi-ai chat history cannot represent structured assistant image output", "UNSUPPORTED_CONTENT");
	}
	return {
		role: "assistant",
		content,
		api: "dsh-foreign",
		provider: source?.provider ?? "dsh-foreign",
		model: source?.model ?? "dsh-foreign",
		usage: emptyPiUsage(),
		stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(message, source, rawState) {
	const state = readReplayState(rawState);
	if (state.provider !== source.provider) return invalidReplay("provider does not match assistant source");
	if (state.model !== source.model) return invalidReplay("model does not match assistant source");
	if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");
	return {
		role: "assistant",
		content: message.content.map((block, index) => {
			const replay = state.blocks[index];
			if (replay === void 0 || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`);
			switch (block.type) {
				case "text": return {
					type: "text",
					text: block.text,
					...replay.type === "text" && replay.textSignature !== void 0 ? { textSignature: replay.textSignature } : {}
				};
				case "reasoning": return {
					type: "thinking",
					thinking: block.text,
					...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {},
					...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {}
				};
				case "tool-call": return {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: parseArguments(block.arguments),
					...replay.type === "tool-call" && replay.thoughtSignature !== void 0 ? { thoughtSignature: replay.thoughtSignature } : {}
				};
				/* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added Harness tag cannot reach this switch */
				default: return invalidReplay(`block ${index} has an unsupported Harness type`);
			}
		}),
		api: state.api,
		provider: state.provider,
		model: state.model,
		...state.responseModel === void 0 ? {} : { responseModel: state.responseModel },
		...state.responseId === void 0 ? {} : { responseId: state.responseId },
		usage: emptyPiUsage(),
		stopReason: state.stopReason,
		timestamp: 0
	};
}
/**
* Convert one durable Harness assistant message into pi-ai history.
* @param message - assistant content with required source and optional adapter-owned replay metadata.
* @returns a native pi-ai assistant message reconstructed from durable content.
*/
function toPiAssistant(message) {
	const source = message.source;
	return source.kind !== "model" || source.replayState === void 0 ? foreignAssistant(message) : replayedAssistant(message, source, source.replayState);
}
//#endregion
//#region src/context.ts
/**
* Harness request-history conversion into pi-ai's Context vocabulary.
*
* @module @devteapot/dsh-openai-codex/context
*/
/** Join the text blocks of a harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}
async function userContent(blocks, attachments) {
	const content = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) content.push({
				type: "text",
				text: block.text
			});
			break;
		case "image": {
			const stored = await attachments.readImage(block.attachment);
			content.push({
				type: "image",
				data: Buffer.from(stored.data).toString("base64"),
				mimeType: stored.ref.mediaType
			});
			break;
		}
		case "tool-result": {
			const nested = await userContent(block.content, attachments);
			if (typeof nested === "string") {
				if (nested.length > 0) content.push({
					type: "text",
					text: nested
				});
			} else content.push(...nested);
		}
	}
	if (content.every((block) => block.type === "text")) return content.map((block) => block.text).join("");
	return content;
}
function toolsOf(options) {
	return options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options, messages) {
	const tools = toolsOf(options);
	return {
		...options.system !== void 0 ? { systemPrompt: options.system } : {},
		messages,
		...tools !== void 0 && tools.length > 0 ? { tools } : {}
	};
}
function textOnlyContext(options) {
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (contentHasImage(message.content)) throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");
		if (message.role === "system") {
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const text = flattenText(message);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (text.length > 0 || results.length === 0) messages.push({
			role: "user",
			content: text,
			timestamp: 0
		});
		for (const result of results) messages.push({
			role: "toolResult",
			toolCallId: result.toolCallId,
			toolName: toolNames.get(result.toolCallId) ?? "unknown",
			content: [{
				type: "text",
				text: toolResultText(result.content) || "(no output)"
			}],
			isError: result.isError ?? false,
			timestamp: 0
		});
	}
	return piContext(options, messages);
}
function toPiContext(options, attachments) {
	return attachments === void 0 ? textOnlyContext(options) : toPiContextWithImages(options, attachments);
}
async function toPiContextWithImages(options, attachments) {
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			if (contentHasImage(message.content)) throw new LlmError("pi-ai cannot represent an image in an in-history system message", "UNSUPPORTED_CONTENT");
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const content = await userContent(message.content.filter((block) => block.type !== "tool-result"), attachments);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (content.length > 0 || results.length === 0) messages.push({
			role: "user",
			content,
			timestamp: 0
		});
		for (const result of results) {
			const resultContent = await userContent(result.content, attachments);
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNames.get(result.toolCallId) ?? "unknown",
				content: typeof resultContent === "string" ? [{
					type: "text",
					text: resultContent || "(no output)"
				}] : resultContent,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	return piContext(options, messages);
}
//#endregion
//#region src/stream.ts
/**
* pi-ai assistant event translation into the Harness streaming protocol.
*
* pi-ai tool-call arguments are parsed objects while the Harness keeps their
* raw JSON representation. pi-ai also reports failures as terminal stream
* events, which this module maps into Harness finish chunks.
*
* @module @devteapot/dsh-openai-codex/stream
*/
/**
* Map pi-ai usage (reasoning folded into output by pi-ai).
* @param usage - cumulative usage from the terminal pi-ai event.
* @returns harness counts; cache fields appear only when non-zero (pi-ai reports zeros, not absence).
*/
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
function classifyPiAiError(message) {
	if (/\b(?:401|403)\b/.test(message)) return "AUTH";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(message)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message) || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message) || /\bterminated\b|premature close/i.test(message)) return "TRANSPORT";
	return "PI_AI_ERROR";
}
/**
* Map a terminal pi-ai event to the harness finish reason.
* @param message - the assistant message carried by the `done` or `error` event.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the mapped harness reason. Recognized error text, `stop` usage above
*   `contextWindow`, and zero-output `length` usage that fills the window map
*   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
*   `EMPTY_RESPONSE` error.
*/
function mapStopReason(message, contextWindow) {
	const piAiOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piAiOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE_CODE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": {
			const text = message.errorMessage ?? "pi-ai stream error";
			return {
				kind: "error",
				failure: {
					message: text,
					code: classifyPiAiError(text)
				}
			};
		}
	}
}
/**
* Translate the pi-ai event stream into StreamChunks. pi-ai never throws
* mid-stream — failures arrive as `error` events, which become error/aborted
* `finish` chunks (the harness protocol's other error-delivery style).
* @param events - one assistant turn's pi-ai event stream.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the harness chunks, ending with `usage` then `finish`; throws
*   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
*/
async function* toStreamChunks(events, contextWindow) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: CallId(known?.id ?? ""),
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: CallId(event.toolCall.id),
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow),
				replayState: toPiReplayState(event.message)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
//#endregion
//#region src/config.ts
/**
* Configuration schema for the OpenAI Codex OAuth adapter. The plugin owns
* the single `openai-codex` route; this section holds deployment knobs, never
* the OAuth token. The token lives under {@link Config.oauthEnv}.
*
* @module dsh-llm-openai-codex/config
*/
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** The single provider route this plugin owns. */
const PROVIDER = "openai-codex";
/** Selector label for the owned route when {@link Config.displayName} is omitted. */
const DEFAULT_DISPLAY_NAME = "OpenAI Codex";
/** Default credential reference storing the serialized OAuth session. */
const DEFAULT_OAUTH_ENV = "OPENAI_CODEX_OAUTH";
/** Settings namespace registered on the optional settings seam. */
const SETTINGS_NS = "llm-openai-codex";
/** Runtime schema for {@link Config}. */
const Config = z.object({
	oauthEnv: z.string().role("credential-ref").default(DEFAULT_OAUTH_ENV),
	displayName: z.string().default(DEFAULT_DISPLAY_NAME),
	reasoning: z.union([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/**
* The one explicit resolve step from raw config to validated connection facts.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts.
*/
function resolveAdapterOptions(config) {
	const displayName = config.displayName ?? "OpenAI Codex";
	if (displayName.length === 0) throw new Error("llm-openai-codex: displayName must not be empty");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-openai-codex: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		oauthEnv: credentialRef(config.oauthEnv ?? "OPENAI_CODEX_OAUTH"),
		displayName,
		...config.reasoning === void 0 ? {} : { reasoning: config.reasoning },
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-openai-codex: retryPolicy")
	};
}
//#endregion
//#region \0@oxc-project+runtime@0.144.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/adapter.ts
/**
* pi-ai-backed adapter for the single `openai-codex` route. A `Models`
* collection holds the catalog provider plus the harness OAuth store, so
* login, refresh, and stream share one session. Conversion of harness
* history and pi-ai events is the same translation `dsh-llm-pi-ai` already
* verified.
*
* @module dsh-llm-openai-codex/adapter
*/
/**
* Build the pi-ai collection this adapter streams through: one Codex provider
* and the harness-owned credential store.
* @param store - OAuth session storage keyed by {@link PROVIDER}.
* @returns a mutable collection the plugin and tests can share.
*/
function createCodexModels(store) {
	const models = createModels({ credentials: store });
	models.setProvider(openaiCodexProvider());
	return models;
}
function describableReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;
}
function resolveReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;
	throw new LlmError(`openai-codex model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
function reasoningInfo(model, defaultLevel) {
	if (!model.reasoning) return {};
	return { reasoning: {
		efforts: getSupportedThinkingLevels(model).map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		})),
		...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }
	} };
}
function streamOptions(reasoning) {
	const enabledReasoning = reasoning === "off" ? void 0 : reasoning;
	return {
		...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },
		maxRetries: 0
	};
}
/**
* Single-route Codex adapter. Each operation reads the current options and
* collection, so a login, logout, or settings change reaches the next request
* without a restart; an in-flight stream keeps the facts it started with.
*/
var OpenAiCodexAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	modelOf(models, model) {
		const resolved = models.getModel(PROVIDER, model);
		if (resolved === void 0) throw new LlmError(`openai-codex has no catalog model "${model}"`, "UNKNOWN_MODEL");
		return resolved;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.config.options().displayName
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve().then(() => {
			if (provider !== "openai-codex") throw new LlmError(`openai-codex adapter does not own provider "${provider}"`, "NO_ADAPTER");
			return this.config.models().getModels(PROVIDER).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: [...model.input]
			}));
		});
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(() => {
			if (provider !== "openai-codex") throw new LlmError(`openai-codex adapter does not own provider "${provider}"`, "NO_ADAPTER");
			const options = this.config.options();
			const resolvedModel = this.modelOf(this.config.models(), model);
			const defaultLevel = describableReasoningLevel(resolvedModel, options.reasoning);
			return {
				provider,
				id: model,
				name: resolvedModel.name,
				inputModalities: [...resolvedModel.input],
				context: { contextWindow: resolvedModel.contextWindow },
				...reasoningInfo(resolvedModel, defaultLevel)
			};
		});
	}
	async *stream(options) {
		try {
			var _usingCtx$1 = _usingCtx();
			if (options.provider !== "openai-codex") throw new LlmError(`openai-codex adapter does not own provider "${options.provider}"`, "NO_ADAPTER");
			if (options.stop !== void 0) throw new LlmError("llm-openai-codex does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
			const connection = this.config.options();
			const models = this.config.models();
			const model = this.modelOf(models, options.model);
			const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? connection.reasoning);
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const streamIdleTimeoutMs = connection.streamIdleTimeoutMs;
			const watchdog = _usingCtx$1.u(idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"));
			try {
				const containsImage = options.messages.some((message) => contentHasImage(message.content));
				if (containsImage && !model.input.includes("image")) throw new LlmError(`openai-codex model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
				const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
				if (containsImage && attachments === void 0) throw new LlmError("openai-codex image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const context = attachments === void 0 ? toPiContext(options) : await toPiContext(options, attachments);
				const iterator = toStreamChunks(models.streamSimple(model, context, {
					...streamOptions(reasoning),
					...options.temperature === void 0 ? {} : { temperature: options.temperature },
					...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
					...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
					signal: watchdog.signal,
					headers: attributionHeaders()
				}), model.contextWindow)[Symbol.asyncIterator]();
				let exhausted = false;
				try {
					while (true) {
						const result = await watchdog.next(iterator);
						const timeout = timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT");
						/* v8 ignore next -- idle expiry is classified after next() returns */
						if (timeout !== void 0) throw timeout;
						if (result.done) {
							exhausted = true;
							return;
						}
						yield result.value;
					}
				} finally {
					if (!exhausted) {
						consumer.abort("openai-codex stream consumer stopped");
						try {
							await iterator.return(void 0);
						} catch (_abortedSdkTeardown) {}
					}
				}
			} catch (error) {
				/* v8 ignore next 6 -- idle expiry needs a signal-honoring provider read; faux factories do not */
				if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`openai-codex stream idle timeout after ${streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("openai-codex request aborted by caller", "ABORTED", { cause: error });
				throw error;
			} finally {
				consumer.abort("openai-codex stream consumer stopped");
			}
		} catch (_) {
			_usingCtx$1.e = _;
		} finally {
			_usingCtx$1.d();
		}
	}
};
//#endregion
//#region src/login.ts
/**
* Build the pi-ai login interaction for one command invocation.
* @param ctx - context that may carry `userQuestions`.
* @param invocation - the `/codex-login` invocation supplying the agent and signal.
* @param ownerSignal - optional host-lifecycle cancellation signal.
* @returns an interaction the command handler passes to {@link OpenAiCodexAuth.login}.
*/
function createCommandInteraction(ctx, invocation, ownerSignal) {
	let authorizationUrl;
	const signal = ownerSignal === void 0 ? invocation.signal : AbortSignal.any([invocation.signal, ownerSignal]);
	return {
		signal,
		notify(event) {
			switch (event.type) {
				case "info":
					ctx.logger.info(event.message);
					for (const link of event.links ?? []) ctx.logger.info(`${link.label ?? "More information"}: ${link.url}`);
					break;
				case "auth_url":
					authorizationUrl = event.url;
					ctx.logger.info(event.instructions ?? "Open this URL to sign in with ChatGPT");
					ctx.logger.info(event.url);
					break;
				case "device_code":
					ctx.logger.info(`Enter code ${event.userCode} at ${event.verificationUri}`);
					break;
				case "progress": ctx.logger.info(event.message);
			}
		},
		async prompt(prompt) {
			const questions = ctx.get("userQuestions");
			if (questions === void 0) throw new Error("llm-openai-codex: /codex-login needs ctx.userQuestions; run it from the Web or TUI, or call ctx.openaiCodex.login() with your own interaction");
			const promptSignal = prompt.signal === void 0 ? signal : AbortSignal.any([signal, prompt.signal]);
			if (prompt.type === "select") {
				const selected = (await questions.ask({
					questions: [{
						id: "codex-login-select",
						question: prompt.message,
						options: prompt.options.map((option) => ({
							label: option.label,
							...option.description === void 0 ? {} : { description: option.description }
						}))
					}],
					agent: invocation.agent,
					signal: promptSignal
				})).answers[0]?.selected[0];
				const match = prompt.options.find((option) => option.label === selected);
				if (match === void 0) throw new Error("llm-openai-codex: login selection was cancelled");
				return match.id;
			}
			const answer = await questions.ask({
				questions: [{
					id: "codex-login-prompt",
					question: prompt.message,
					...prompt.type === "manual_code" ? authorizationUrl === void 0 ? {} : { detail: authorizationUrl } : prompt.placeholder === void 0 ? {} : { detail: prompt.placeholder }
				}],
				agent: invocation.agent,
				signal: promptSignal
			});
			const text = answer.answers[0]?.custom ?? answer.answers[0]?.selected[0] ?? "";
			if (text.length === 0 && prompt.type !== "manual_code") throw new Error("llm-openai-codex: login prompt was cancelled");
			return text;
		}
	};
}
//#endregion
//#region src/store.ts
/**
* pi-ai `CredentialStore` backed by one harness credential reference.
* The store holds a single OAuth session for {@link PROVIDER}; every other
* provider id is absent. `modify` is the only write path so pi-ai can refresh
* under its lock without this package knowing about token expiry.
*
* @module dsh-llm-openai-codex/store
*/
/**
* Serialize one OAuth credential as compact JSON for the credential seam.
* @param credential - the session pi-ai returned from login or refresh.
* @returns a single-line JSON document the store can persist.
*/
function serializeOAuthCredential(credential) {
	return JSON.stringify(credential);
}
/**
* Parse a stored session. Rejects rather than treating garbage as absent, so a
* corrupted value cannot silently fall through to "not logged in".
* @param raw - the stored JSON document.
* @returns the parsed OAuth credential.
*/
function parseOAuthCredential(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new LlmError("llm-openai-codex: stored OAuth session is not JSON; log in again or replace the credential", "INVALID_CREDENTIAL", { cause });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new LlmError("llm-openai-codex: stored OAuth session must be a JSON object", "INVALID_CREDENTIAL");
	const record = parsed;
	if (record.type !== "oauth" || typeof record.access !== "string" || record.access.length === 0 || typeof record.refresh !== "string" || record.refresh.length === 0 || typeof record.expires !== "number" || !Number.isFinite(record.expires)) throw new LlmError("llm-openai-codex: stored OAuth session is missing type, access, refresh, or expires", "INVALID_CREDENTIAL");
	return record;
}
/**
* Build a pi-ai credential store over one harness credential reference.
* @param hooks - read/write/unset for the serialized session.
* @returns a store keyed only by {@link PROVIDER}.
*/
function createOAuthStore(hooks) {
	const chains = /* @__PURE__ */ new Map();
	const enqueue = async (providerId, task) => {
		const next = (chains.get(providerId) ?? Promise.resolve()).then(task, task);
		chains.set(providerId, next.then(() => void 0, () => void 0));
		return next;
	};
	const readOwned = async (access = hooks.access()) => {
		const raw = await access.read();
		if (raw === void 0 || raw.length === 0) return void 0;
		return parseOAuthCredential(raw);
	};
	return {
		async read(providerId) {
			if (providerId !== "openai-codex") return void 0;
			return readOwned();
		},
		async list() {
			return await readOwned() === void 0 ? [] : [{
				providerId: PROVIDER,
				type: "oauth"
			}];
		},
		modify(providerId, fn) {
			return enqueue(providerId, async () => {
				if (providerId !== "openai-codex") return void 0;
				const access = hooks.access();
				const current = await readOwned(access);
				const next = await fn(current);
				if (next === void 0) return current;
				if (next.type !== "oauth") throw new LlmError("llm-openai-codex: refusing to store a non-OAuth credential on the Codex route", "INVALID_CREDENTIAL");
				await access.write(serializeOAuthCredential(next));
				return next;
			});
		},
		delete(providerId) {
			return enqueue(providerId, async () => {
				if (providerId !== "openai-codex") return;
				await hooks.access().unset();
			});
		}
	};
}
//#endregion
//#region src/index.ts
/**
* Register an {@link OpenAiCodexAdapter} for the `openai-codex` provider
* route on `ctx.llm`. The route is dormant until an OAuth session is stored
* under the configured `oauthEnv` reference; `/codex-login` and
* {@link OpenAiCodexAuth.login} persist that session, and pi-ai refreshes it
* on the next request under the store lock.
*
* @module @devteapot/dsh-openai-codex
*/
const name = "llm-openai-codex";
const inject = ["llm"];
const NS = settingsNamespace(SETTINGS_NS);
/** Login, logout, and status for the ChatGPT OAuth session this plugin stores. */
var OpenAiCodexAuth = class extends Service {
	ops;
	constructor(ctx, ops) {
		super(ctx, "openaiCodex");
		this.ops = ops;
	}
	/**
	* Run the Codex OAuth login and persist the returned session.
	* @param interaction - prompts and notifications the host UI implements.
	* @returns after the session is stored and the route is registered.
	*/
	login(interaction) {
		return this.ops.login(interaction);
	}
	/**
	* Drop the stored session and withdraw the `openai-codex` route.
	* @returns after the credential is removed and the route is withdrawn.
	*/
	logout() {
		return this.ops.logout();
	}
	/**
	* Report whether a stored OAuth session currently exists.
	* @returns `{ configured: true }` when the store can read a session.
	*/
	status() {
		return this.ops.status();
	}
};
/**
* Persistence hooks that read the OAuth session from `ctx.credentials` or the
* launch environment, and write only through the credentials service.
* @param ctx - context that may carry `credentials`.
* @param options - current validated connection facts.
* @returns hooks for {@link createOAuthStore}.
*/
function createStoreHooks(ctx, options) {
	const access = () => {
		const ref = options().oauthEnv;
		const credentials = ctx.get("credentials");
		return {
			read: async () => {
				if (credentials !== void 0) return (await credentials.resolve(ref))?.value;
				const ambient = launchEnvironmentOf(ctx).get(ref);
				if (ambient === void 0 || ambient.value.length === 0) return void 0;
				return ambient.value;
			},
			write: async (value) => {
				if (credentials === void 0) throw new LlmError("llm-openai-codex: login needs the credentials service to store the OAuth session; mount dsh-credentials-local", "MISSING_CREDENTIAL");
				await credentials.set(ref, value);
			},
			unset: async () => {
				if (credentials === void 0) return;
				await credentials.unset(ref);
			}
		};
	};
	return { access };
}
/**
* Register the Codex adapter, OAuth service, and optional `/codex-login`
* / `/codex-logout` commands.
* @param ctx - context carrying `ctx.llm` and optional settings/credentials/commands.
* @param config - composition entry config, used as the settings base.
*/
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			/* v8 ignore start -- validate refuses an unserviceable write; this keeps serving if one still lands. */
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-openai-codex: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	options();
	const store = createOAuthStore(createStoreHooks(ctx, options));
	const models = createCodexModels(store);
	const adapter = new OpenAiCodexAdapter({
		options,
		models: () => models,
		/* v8 ignore next -- image requests on this instance hit it; text-only catalog models throw first */
		resolveAttachments: () => ctx.get("attachments")
	});
	let registration;
	let registeredPolicy = options().retryPolicy;
	let registeredDisplayName = options().displayName;
	let registrationSync = Promise.resolve();
	let registrationClosed = false;
	const ensureRegistration = async () => {
		const facts = options();
		const listed = await store.list();
		if (registrationClosed) return;
		const ready = listed.some((entry) => entry.providerId === PROVIDER);
		const policyChanged = !deepEqualJson(facts.retryPolicy, registeredPolicy) || facts.displayName !== registeredDisplayName;
		if (!ready) {
			if (registration !== void 0) {
				registration.replace([]);
				registeredPolicy = facts.retryPolicy;
				registeredDisplayName = facts.displayName;
			}
			return;
		}
		if (registration === void 0) registration = ctx.llm.registerAdapter([PROVIDER], adapter);
		else if (policyChanged) registration.replace([PROVIDER]);
		registeredPolicy = facts.retryPolicy;
		registeredDisplayName = facts.displayName;
	};
	const syncRegistration = () => {
		queueRegistration().catch((error) => {
			ctx.logger.error("llm-openai-codex: failed to refresh the openai-codex route");
			ctx.logger.error(error);
		});
	};
	const queueRegistration = () => {
		if (registrationClosed) return Promise.resolve();
		const next = registrationSync.then(async () => {
			if (!registrationClosed) await ensureRegistration();
		});
		registrationSync = next.catch(() => void 0);
		return next;
	};
	syncRegistration();
	ctx.on("credentials/updated", (ref) => {
		if (ref === options().oauthEnv) syncRegistration();
	});
	new OpenAiCodexAuth(ctx, {
		login: async (interaction) => {
			await models.login(PROVIDER, "oauth", interaction);
			await queueRegistration();
		},
		logout: async () => {
			await models.logout(PROVIDER);
			await queueRegistration();
		},
		status: async () => {
			return { configured: (await store.list()).some((entry) => entry.providerId === PROVIDER) };
		}
	});
	ctx.inject(["commands"], (commandCtx) => {
		const active = /* @__PURE__ */ new Set();
		const lifetime = new AbortController();
		const errorText = (error) => error instanceof Error ? error.message : String(error);
		const run = (operation) => {
			active.add(operation);
			const retire = () => {
				active.delete(operation);
			};
			operation.then(retire, retire);
			return operation;
		};
		commandCtx.effect(function* () {
			yield async () => {
				lifetime.abort("llm-openai-codex commands disposed");
				await Promise.allSettled(active);
			};
			yield commandCtx.commands.register({
				name: "codex-login",
				description: "Sign in to OpenAI Codex with a ChatGPT Plus or Pro account",
				handler: async (invocation) => {
					try {
						await run(commandCtx.openaiCodex.login(createCommandInteraction(commandCtx, invocation, lifetime.signal)));
						return {
							kind: "success",
							text: "Signed in to OpenAI Codex. Codex models are available in the model picker."
						};
					} catch (error) {
						/* v8 ignore next -- command dispatch aborts the execute promise before this catch */
						if (invocation.signal.aborted) return {
							kind: "error",
							text: "Codex login cancelled."
						};
						return {
							kind: "error",
							text: errorText(error)
						};
					}
				}
			});
			yield commandCtx.commands.register({
				name: "codex-logout",
				description: "Remove the stored OpenAI Codex session",
				handler: async (invocation) => {
					if (invocation.rawInput.trim().length > 0) return {
						kind: "error",
						text: "Usage: /codex-logout (no arguments)"
					};
					try {
						await run(commandCtx.openaiCodex.logout());
						return {
							kind: "success",
							text: "Signed out of OpenAI Codex."
						};
					} catch (error) {
						return {
							kind: "error",
							text: errorText(error)
						};
					}
				}
			});
		}, "llm-openai-codex commands");
	});
	installSettingsSection(ctx, NS, Config, config, {
		validate: (value) => {
			resolveAdapterOptions(value);
		},
		setSource: (source) => {
			current = source;
		},
		onChange: syncRegistration
	});
	ctx.effect(function* () {
		yield async () => {
			registrationClosed = true;
			await registrationSync;
		};
	}, "llm-openai-codex registration synchronization");
}
//#endregion
export { Config, DEFAULT_DISPLAY_NAME, DEFAULT_OAUTH_ENV, DEFAULT_STREAM_IDLE_TIMEOUT_MS, OpenAiCodexAdapter, OpenAiCodexAuth, PROVIDER, SETTINGS_NS, apply, createCodexModels, createCommandInteraction, createOAuthStore, createStoreHooks, inject, name, parseOAuthCredential, resolveAdapterOptions, serializeOAuthCredential };

//# sourceMappingURL=index.js.map