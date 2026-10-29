import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import type { FormatModel } from "../../model/Format.model.js";
import { validateToolArguments } from "../../helpers/validateToolArguments.js";

export const PROVIDE_ANSWER_TOOL = "provide_answer";

export interface ProvideAnswerHandle {
  tool: AgentTool;
  /** The accepted answer, once the model has called the tool with valid arguments. */
  readonly answer: unknown | undefined;
  readonly hasAnswer: boolean;
  /** Validation failures seen so far, in order. */
  readonly failures: string[];
}

/**
 * The `provide_answer` tool from json-inference, hosted inside the pi agent loop:
 * the request schema becomes the tool parameters, the arguments are validated
 * against it and a valid call ends the run.
 */
export const createProvideAnswerTool = (schema: FormatModel): ProvideAnswerHandle => {
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
    parameters: schema as unknown as TSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const validation = validateToolArguments(params, schema);
      if (!validation.success) {
        failures.push(validation.error ?? "Validation failed");
        throw new Error(`${validation.error}. Fix the arguments and call ${PROVIDE_ANSWER_TOOL} again.`);
      }
      answer = validation.data;
      hasAnswer = true;
      return {
        content: [{ type: "text", text: "Answer accepted." }],
        details: { accepted: true },
        terminate: true,
      };
    },
  };

  return {
    tool,
    get answer() {
      return answer;
    },
    get hasAnswer() {
      return hasAnswer;
    },
    failures,
  };
};
