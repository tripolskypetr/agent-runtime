import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import type { FormatModel } from "../../model/Format.model.js";
import { toModelSchema } from "../../helpers/schema.js";
import { validateToolArguments } from "../../helpers/validateToolArguments.js";
import { getLogger, type ScopedLogger } from "../../lib/logger.js";

export const PROVIDE_ANSWER_TOOL = "provide_answer";

export interface ProvideAnswerHandle {
  tool: AgentTool;
  /** The schema the model sees (meta keywords removed, $refs inlined); sent as the tool parameters to Ollama and printed in the prompt. */
  modelSchema: Record<string, unknown>;
  /** The accepted answer, once the model has called the tool with valid arguments. */
  readonly answer: unknown | undefined;
  readonly hasAnswer: boolean;
  /** Validation failures seen so far, in order. */
  readonly failures: string[];
}

/**
 * The `provide_answer` tool from json-inference, hosted inside the pi agent loop:
 * the request schema becomes the tool parameters the model sees, the arguments
 * are validated against the full schema with ajv and a valid call ends the run.
 *
 * pi validates tool arguments itself (TypeBox) against `tool.parameters` before
 * `execute` runs, with coercion and terse messages ("must be equal to constant",
 * "root: must match then schema"). To keep one validator and readable feedback,
 * pi is given a permissive parameters schema and the real model-facing schema is
 * substituted into the Ollama request by the stream function (`toolParameters`).
 */
export const createProvideAnswerTool = (schema: FormatModel, logger: ScopedLogger = getLogger("tool:provide_answer")): ProvideAnswerHandle => {
  const log = logger.child(PROVIDE_ANSWER_TOOL);
  const modelSchema = toModelSchema(schema as unknown as Record<string, unknown>);
  let answer: unknown | undefined;
  let hasAnswer = false;
  const failures: string[] = [];

  const tool: AgentTool = {
    name: PROVIDE_ANSWER_TOOL,
    label: "Provide answer",
    description:
      "Submit the final answer in the required structured format. " +
      "This is the only way to finish the task: plain text replies are not accepted. " +
      "Call it exactly once, after you have gathered everything you need, with arguments that match the schema.",
    // permissive on purpose: validation happens in execute() against the full schema; see createOllamaStreamFn toolParameters
    parameters: { type: "object", additionalProperties: true } as unknown as TSchema,
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      const validation = validateToolArguments(params, schema);
      if (!validation.success) {
        failures.push(validation.error ?? "Validation failed");
        log.warn("answer rejected", { toolCallId, error: validation.error, arguments: params, failuresSoFar: failures.length });
        throw new Error(`${validation.error}. Fix the arguments and call ${PROVIDE_ANSWER_TOOL} again.`);
      }
      answer = validation.data;
      hasAnswer = true;
      log.info("answer accepted", { toolCallId, answer: validation.data });
      return {
        content: [{ type: "text", text: "Answer accepted." }],
        details: { accepted: true },
        terminate: true,
      };
    },
  };

  return {
    tool,
    modelSchema,
    get answer() {
      return answer;
    },
    get hasAnswer() {
      return hasAnswer;
    },
    failures,
  };
};
